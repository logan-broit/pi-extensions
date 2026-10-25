import assert from "node:assert/strict";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { test } from "vitest";
import { maskSecrets, OtelObservation } from "../src/otel-observation.js";

test("whole configured credentials are masked before generic prefixes and overlapping values", () => {
  assert.equal(
    maskSecrets("prefix key-long-tail suffix", ["key", "key-long-tail"]),
    "prefix [LANGFUSE_KEY_REDACTED] suffix",
  );
  assert.equal(maskSecrets("sk-lf-prefix!private-tail", ["sk-lf-prefix!private-tail"]), "[LANGFUSE_KEY_REDACTED]");
});

test("deep serialized objects cannot overflow masking or leak hidden credentials", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  try {
    let nested: unknown = { secret: "secret-value" };
    for (let depth = 0; depth < 2_000; depth++) nested = { nested };
    const observation = new OtelObservation(provider.getTracer("test").startSpan("deep"), ["secret-value"]);
    assert.doesNotThrow(() => observation.update({ input: nested, metadata: { nested } }).end());
    await provider.forceFlush();
    const [span] = exporter.getFinishedSpans();
    assert.ok(span);
    assert.equal(JSON.stringify(span.attributes).includes("secret-value"), false);
    assert.ok(JSON.stringify(span.attributes).includes("maximum depth reached"));
  } finally {
    await provider.shutdown();
  }
});

test("repeated metadata updates reserve slots for final observation and trace fields", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
    spanLimits: { attributeCountLimit: 1_024 },
  });
  try {
    const observation = new OtelObservation(provider.getTracer("test").startSpan("bounded"), []);
    observation.update({
      metadata: Object.fromEntries(Array.from({ length: 1_100 }, (_, index) => [`omitted${index}`, undefined])),
    });
    for (let batch = 0; batch < 10; batch++) {
      const metadata = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`batch${batch}.${index}`, index]));
      observation.update({ metadata });
      observation.updateTrace({ metadata });
    }
    observation.update({
      output: "final output",
      level: "ERROR",
      statusMessage: "final status",
      model: "model",
      modelParameters: { temperature: 0 },
      costDetails: { total: 0 },
      usageDetails: { input: 1 },
      completionStartTime: new Date(1_000),
      version: "2",
      sessionId: "session",
      userId: "user",
    });
    observation.updateTrace({ output: "trace output", name: "trace", tags: ["tag"] });
    observation.update({ metadata: { "batch0.0": "updated" } }).end();
    await provider.forceFlush();
    const [span] = exporter.getFinishedSpans();
    assert.ok(span);
    assert.equal(span.droppedAttributesCount, 0);
    assert.equal(Object.keys(span.attributes).filter((key) => key.includes(".metadata.")).length, 400);
    assert.equal(span.attributes["langfuse.observation.metadata.batch0.0"], '"updated"');
    assert.equal(span.attributes["langfuse.observation.output"], "final output");
    assert.equal(span.attributes["langfuse.observation.level"], "ERROR");
    assert.equal(span.attributes["langfuse.observation.status_message"], "final status");
    assert.equal(span.attributes["langfuse.observation.model.name"], "model");
    assert.equal(span.attributes["langfuse.trace.output"], "trace output");
    assert.equal(span.attributes["langfuse.trace.name"], "trace");
    assert.deepEqual(span.attributes["langfuse.trace.tags"], ["tag"]);
  } finally {
    await provider.shutdown();
  }
});
