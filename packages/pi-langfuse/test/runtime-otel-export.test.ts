import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createLangfuseRuntime, createProductionBackend } from "../src/runtime.js";
import { TraceRecorder } from "../src/tracing.js";
import { decodeExport, type OtlpSpan, startCollector } from "./otel-collector.js";

function attributes(span: OtlpSpan) {
  return Object.fromEntries(
    span.attributes.map(({ key, value }) => [
      key,
      value.stringValue ?? value.boolValue ?? value.arrayValue?.values.map((item) => item.stringValue),
    ]),
  );
}
function clearRuntime() {
  const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
  delete globals[Symbol.for("@narumitw/pi-langfuse/runtime/v1")];
  delete globals[Symbol.for("@narumitw/pi-langfuse/runtime/v2")];
}

test("production runtime exports independent Langfuse wire fixtures through standard OTLP JSON gzip", async () => {
  const collector = await startCollector();
  vi.stubEnv("LANGFUSE_OTEL_COMPRESSION", "gzip");
  vi.stubEnv("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "1");
  vi.stubEnv("OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT", "1");
  const config = {
    publicKey: "pk-wire",
    secretKey: "secret-wire",
    baseUrl: `${collector.baseUrl}/prefix/`,
    environment: "staging",
    release: "release-secret-wire",
    captureContent: true,
  };
  const backend = await createProductionBackend(config);
  try {
    const root = backend.start(
      "root",
      {
        input: { text: 'pk-wire "secret-wire"' },
        sessionId: "session",
        userId: "user",
        version: "2",
        metadata: { nested: { ok: true }, number: 0, secret: "secret-wire" },
      },
      { asType: "agent", startTime: new Date(1_000) },
    );
    root.updateTrace?.({ name: "trace", input: "trace input", output: "trace output", tags: ["tag"] });
    const child = backend.start(
      "generation",
      {
        input: "question",
        output: "data:image/png;base64,c2VjcmV0",
        level: "WARNING",
        statusMessage: "secret-wire",
        model: "model",
        completionStartTime: new Date(1_200),
        modelParameters: { temperature: 0 },
        usageDetails: { input: 2, output: 1 },
        costDetails: { total: 0.03 },
        sessionId: "session",
        userId: "user",
      },
      { asType: "generation", parent: root, startTime: new Date(1_100) },
    );
    child.end(1_400);
    root.end(1_500);
    await backend.forceFlush();
    const request = await collector.next();
    assert.equal(request.url, "/prefix/api/public/otel/v1/traces");
    assert.equal(request.headers.authorization, `Basic ${Buffer.from("pk-wire:secret-wire").toString("base64")}`);
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["content-encoding"], "gzip");
    assert.equal(request.headers["x-langfuse-ingestion-version"], "4");
    const body = decodeExport(request);
    const scopes = body.resourceSpans.flatMap((resource) => resource.scopeSpans);
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0]?.scope.name, "@narumitw/pi-langfuse");
    const spans = scopes.flatMap((scope) => scope.spans);
    assert.equal(spans.length, 2);
    const rootSpan = spans.find((span) => span.name === "root");
    const childSpan = spans.find((span) => span.name === "generation");
    assert.ok(rootSpan);
    assert.ok(childSpan);
    assert.equal(rootSpan.parentSpanId, undefined);
    assert.equal(childSpan.parentSpanId, rootSpan.spanId);
    assert.equal(childSpan.traceId, rootSpan.traceId);
    assert.equal(rootSpan.traceId, root.traceId);
    assert.equal(childSpan.startTimeUnixNano, "1100000000");
    assert.equal(childSpan.endTimeUnixNano, "1400000000");
    assert.deepEqual(attributes(rootSpan), {
      "langfuse.observation.type": "agent",
      "langfuse.internal.is_app_root": true,
      "langfuse.environment": "staging",
      "langfuse.release": "release-[LANGFUSE_KEY_REDACTED]",
      "langfuse.observation.input": JSON.stringify({ text: '[LANGFUSE_KEY_REDACTED] "[LANGFUSE_KEY_REDACTED]"' }),
      "session.id": "session",
      "user.id": "user",
      "langfuse.version": "2",
      "langfuse.observation.metadata.nested": '{"ok":true}',
      "langfuse.observation.metadata.number": "0",
      "langfuse.observation.metadata.secret": '"[LANGFUSE_KEY_REDACTED]"',
      "langfuse.trace.name": "trace",
      "langfuse.trace.input": "trace input",
      "langfuse.trace.output": "trace output",
      "langfuse.trace.tags": ["tag"],
    });
    assert.deepEqual(attributes(childSpan), {
      "langfuse.observation.type": "generation",
      "langfuse.environment": "staging",
      "langfuse.release": "release-[LANGFUSE_KEY_REDACTED]",
      "langfuse.observation.input": "question",
      "langfuse.observation.output": "[base64 data URI omitted]",
      "langfuse.observation.level": "WARNING",
      "langfuse.observation.status_message": "[LANGFUSE_KEY_REDACTED]",
      "langfuse.observation.model.name": "model",
      "langfuse.observation.completion_start_time": '"1970-01-01T00:00:01.200Z"',
      "langfuse.observation.model.parameters": '{"temperature":0}',
      "langfuse.observation.usage_details": '{"input":2,"output":1}',
      "langfuse.observation.cost_details": '{"total":0.03}',
      "session.id": "session",
      "user.id": "user",
    });
    const serialized = JSON.stringify(body);
    for (const secret of ["pk-wire", "secret-wire", "c2VjcmV0", Buffer.from("pk-wire:secret-wire").toString("base64")])
      assert.equal(serialized.includes(secret), false);
  } finally {
    await backend.shutdown();
    clearRuntime();
    vi.unstubAllEnvs();
    await collector.close();
  }
});

test("disabled recorder content and pending spans are settled before runtime shutdown exports", async () => {
  const collector = await startCollector();
  const config = {
    publicKey: "pk-disabled",
    secretKey: "sk-disabled",
    baseUrl: collector.baseUrl,
    captureContent: false,
  };
  const backend = await createProductionBackend(config);
  const runtime = await createLangfuseRuntime({ config, env: false });
  try {
    const recorder = new TraceRecorder(backend, {
      sessionId: "disabled",
      cwd: "/workspace",
      mode: "json",
      captureContent: false,
    });
    recorder.beginAgent({ prompt: "private prompt" });
    recorder.finishAttempt({ role: "assistant", content: "private response", stopReason: "stop" });
    recorder.settle();
    await Promise.all([runtime.shutdown(), runtime.shutdown()]);
    const request = await collector.next();
    const payload = JSON.stringify(decodeExport(request));
    assert.equal(payload.includes("private prompt"), false);
    assert.equal(payload.includes("private response"), false);
    assert.ok(payload.includes("content capture disabled"));
    assert.equal(runtime.closed, true);
    await assert.rejects(runtime.flush(), /closed|shutting down/);
  } finally {
    await runtime.shutdown().catch(() => undefined);
    clearRuntime();
    await collector.close();
  }
});
