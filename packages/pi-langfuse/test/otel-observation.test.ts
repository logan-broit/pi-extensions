import assert from "node:assert/strict";
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { test } from "vitest";
import { OtelObservation } from "../src/otel-observation.js";

function harness() {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
    spanLimits: { attributeCountLimit: 1_024, attributeValueLengthLimit: 65_536 },
  });
  const span = provider.getTracer("mapping-test").startSpan("original", { startTime: new Date(0) });
  return { exporter, provider, observation: new OtelObservation(span, ['pk-quote"', "secret-value"]) };
}

test("mapping covers every public observation field without changing receiver or span name", async () => {
  const { exporter, provider, observation } = harness();
  try {
    assert.equal(
      observation.update({
        name: "ignored",
        tags: ["ignored"],
        input: { question: "hello" },
        output: false,
        metadata: {
          text: "hi",
          zero: 0,
          flag: false,
          nested: { list: [1, 2] },
          omitted: null,
          infinity: Infinity,
          bigint: 1n,
        },
        level: "ERROR",
        statusMessage: "failed secret-value",
        completionStartTime: new Date(1_000),
        model: "model",
        modelParameters: { temperature: 0 },
        usageDetails: { input: 1, output: 2 },
        costDetails: { total: 0.03 },
        version: "2",
        sessionId: "session",
        userId: "user",
      }),
      observation,
    );
    observation.updateTrace({
      input: "trace input",
      output: 0,
      metadata: { nil: null, number: Number.NaN },
      name: "trace name",
      tags: ["one", "secret-value"],
      version: "3",
    });
    observation.update({ input: undefined, output: null });
    observation.end(2_000);
    observation.update({ input: "after end" });
    observation.updateTrace({ output: "after end" });
    observation.end(3_000);
    await provider.forceFlush();
    const [span] = exporter.getFinishedSpans();
    assert.ok(span);
    assert.equal(span.name, "original");
    assert.deepEqual(span.attributes, {
      "langfuse.observation.input": '{"question":"hello"}',
      "langfuse.observation.output": "false",
      "langfuse.observation.metadata.text": '"hi"',
      "langfuse.observation.metadata.zero": "0",
      "langfuse.observation.metadata.flag": "false",
      "langfuse.observation.metadata.nested": '{"list":[1,2]}',
      "langfuse.observation.metadata.infinity": '"Infinity"',
      "langfuse.observation.metadata.bigint": "1",
      "langfuse.observation.level": "ERROR",
      "langfuse.observation.status_message": "failed [LANGFUSE_KEY_REDACTED]",
      "langfuse.observation.completion_start_time": '"1970-01-01T00:00:01.000Z"',
      "langfuse.observation.model.name": "model",
      "langfuse.observation.model.parameters": '{"temperature":0}',
      "langfuse.observation.usage_details": '{"input":1,"output":2}',
      "langfuse.observation.cost_details": '{"total":0.03}',
      "langfuse.version": "3",
      "session.id": "session",
      "user.id": "user",
      "langfuse.trace.input": "trace input",
      "langfuse.trace.output": "0",
      "langfuse.trace.metadata.nil": "null",
      "langfuse.trace.metadata.number": "null",
      "langfuse.trace.name": "trace name",
      "langfuse.trace.tags": ["one", "[LANGFUSE_KEY_REDACTED]"],
    });
    // Existing adapter encoded Langfuse level without setting the OTel status.
    assert.equal(span.status.code, SpanStatusCode.UNSET);
    assert.deepEqual(span.endTime, [2, 0]);
  } finally {
    await provider.shutdown();
  }
});

for (const [value, expected] of [
  [undefined, undefined],
  [null, undefined],
  ["", ""],
  [false, "false"],
  [0, "0"],
  [NaN, "null"],
  [Infinity, "null"],
  [1n, "<failed to serialize>"],
  [() => undefined, undefined],
  [Symbol("omitted"), undefined],
  [{ toJSON: () => "custom" }, '"custom"'],
  [{ toJSON: () => undefined }, undefined],
  [new Date(0), '"1970-01-01T00:00:00.000Z"'],
] as const) {
  test(`observation IO serializer preserves ${typeof value} ${String(value)}`, async () => {
    const { exporter, provider, observation } = harness();
    try {
      observation.update({ input: value, output: value }).end();
      await provider.forceFlush();
      const [span] = exporter.getFinishedSpans();
      assert.equal(span?.attributes["langfuse.observation.input"], expected);
      assert.equal(span?.attributes["langfuse.observation.output"], expected);
    } finally {
      await provider.shutdown();
    }
  });
}

test("JSON attributes remain bounded, valid and masked after serialization hooks", async () => {
  const { exporter, provider, observation } = harness();
  try {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    observation
      .update({
        input: { toJSON: () => ({ 'pk-quote"': "secret-value data:text/plain;base64,c2VjcmV0" }) },
        output: { big: "🙂".repeat(50_000) },
        metadata: { circular, hugeBigint: 9_007_199_254_740_992n },
      })
      .end();
    await provider.forceFlush();
    const [span] = exporter.getFinishedSpans();
    assert.ok(span);
    assert.deepEqual(JSON.parse(String(span.attributes["langfuse.observation.input"])), {
      "[LANGFUSE_KEY_REDACTED]": "[LANGFUSE_KEY_REDACTED] [base64 data URI omitted]",
    });
    assert.ok(Buffer.byteLength(String(span.attributes["langfuse.observation.output"])) <= 65_536);
    assert.doesNotThrow(() => JSON.parse(String(span.attributes["langfuse.observation.output"])));
    assert.equal(span.attributes["langfuse.observation.metadata.circular"], '"<failed to serialize>"');
    assert.equal(span.attributes["langfuse.observation.metadata.hugeBigint"], '"9007199254740992"');
    assert.equal(JSON.stringify(span.attributes).includes("c2VjcmV0"), false);
  } finally {
    await provider.shutdown();
  }
});
