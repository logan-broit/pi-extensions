import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { inspect } from "node:util";
import { DiagLogLevel, diag, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { afterEach, test, vi } from "vitest";
import { createLangfuseProcessor } from "../src/otel-exporter.js";
import { decodeExport, startCollector } from "./otel-collector.js";

const publicKey = "pk-lf-local-public";
const secretKey = "sk-lf-local-secret";
const authorization = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
const cleanup: (() => Promise<void>)[] = [];

function provider(baseUrl: string, env: NodeJS.ProcessEnv | false = false) {
  const processor = createLangfuseProcessor({ publicKey, secretKey, baseUrl }, env);
  const result = new TracerProvider({ spanProcessors: [processor] });
  cleanup.push(() => result.shutdown().catch(() => undefined));
  return result;
}

function captureDiagnostics(): unknown[][] {
  const output: unknown[][] = [];
  const log = (...args: unknown[]) => output.push(args);
  diag.setLogger({ error: log, warn: log, info: log, debug: log, verbose: log }, DiagLogLevel.ALL);
  return output;
}

function assertNoCredentials(data: unknown): void {
  const text = inspect(data, { depth: null });
  for (const secret of [publicKey, secretKey, authorization, authorization.slice(6)]) {
    assert.ok(!text.includes(secret), "Credentials must remain in the authentication header.");
  }
}

async function assertExportFailure(flush: Promise<void>): Promise<void> {
  await assert.rejects(flush, (errors: unknown) => {
    assert.ok(Array.isArray(errors));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "Langfuse span export failed.");
    assertNoCredentials(errors);
    return true;
  });
}

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  diag.disable();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("exports real gzip OTLP JSON with explicit path, authentication, scope, hierarchy and fields", async () => {
  const collector = await startCollector();
  cleanup.push(() => collector.close());
  const logs = captureDiagnostics();
  const instance = provider(`${collector.baseUrl}/prefix///`);
  const tracer = instance.getTracer("@narumitw/pi-langfuse", "fixture");
  const root = tracer.startSpan("pi.agent", { startTime: [1_700_000_000, 123_000_000] }, ROOT_CONTEXT);
  root.setAttributes({
    "langfuse.observation.type": "agent",
    "langfuse.internal.as_root": true,
    "langfuse.trace.input": '{"prompt":"hello"}',
    "langfuse.trace.output": '{"answer":"world"}',
    "langfuse.trace.metadata.build": '"local"',
    "session.id": "session-fixture",
    "user.id": "user-fixture",
    "langfuse.trace.tags": ["fixture", "local"],
    "langfuse.environment": "test",
    "langfuse.release": "release-fixture",
  });
  const child = tracer.startSpan("completion", {}, trace.setSpan(ROOT_CONTEXT, root));
  child.setAttributes({
    "langfuse.observation.type": "generation",
    "langfuse.observation.model.name": "fixture-model",
    "langfuse.observation.usage_details": '{"input":12,"output":3}',
    "langfuse.observation.cost_details": '{"total":0.25}',
  });
  child.end();
  root.end([1_700_000_001, 456_000_000]);
  await instance.forceFlush();
  assert.equal(collector.requests.length, 1);
  const request = await collector.next();
  assert.equal(request.url, "/prefix/api/public/otel/v1/traces");
  assert.equal(request.headers.authorization, authorization);
  assert.equal(request.headers["x-langfuse-ingestion-version"], "4");
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.headers["content-encoding"], "gzip");
  assert.equal(request.headers["x-langfuse-public-key"], undefined);
  assert.equal(request.headers["x-langfuse-sdk-name"], undefined);
  const decoded = decodeExport(request);
  const resource = decoded.resourceSpans[0];
  assert.ok(resource.resource.attributes.some((attribute) => attribute.key === "telemetry.sdk.name"));
  const scope = resource.scopeSpans[0];
  assert.equal(scope.scope.name, "@narumitw/pi-langfuse");
  assert.equal(scope.scope.version, "fixture");
  const wireRoot = scope.spans.find((span) => span.name === "pi.agent");
  const wireChild = scope.spans.find((span) => span.name === "completion");
  assert.ok(wireRoot && wireChild);
  assert.equal(wireRoot.traceId, root.spanContext().traceId);
  assert.equal(wireRoot.spanId, root.spanContext().spanId);
  assert.equal(wireChild.traceId, wireRoot.traceId);
  assert.equal(wireChild.parentSpanId, wireRoot.spanId);
  assert.equal(wireRoot.startTimeUnixNano, "1700000000123000000");
  assert.equal(wireRoot.endTimeUnixNano, "1700000001456000000");
  assert.deepEqual(Object.fromEntries(wireRoot.attributes.map(({ key, value }) => [key, value])), {
    "langfuse.observation.type": { stringValue: "agent" },
    "langfuse.internal.as_root": { boolValue: true },
    "langfuse.trace.input": { stringValue: '{"prompt":"hello"}' },
    "langfuse.trace.output": { stringValue: '{"answer":"world"}' },
    "langfuse.trace.metadata.build": { stringValue: '"local"' },
    "session.id": { stringValue: "session-fixture" },
    "user.id": { stringValue: "user-fixture" },
    "langfuse.trace.tags": { arrayValue: { values: [{ stringValue: "fixture" }, { stringValue: "local" }] } },
    "langfuse.environment": { stringValue: "test" },
    "langfuse.release": { stringValue: "release-fixture" },
  });
  assert.deepEqual(Object.fromEntries(wireChild.attributes.map(({ key, value }) => [key, value.stringValue])), {
    "langfuse.observation.type": "generation",
    "langfuse.observation.model.name": "fixture-model",
    "langfuse.observation.usage_details": '{"input":12,"output":3}',
    "langfuse.observation.cost_details": '{"total":0.25}',
  });
  assertNoCredentials(decoded);
  assertNoCredentials(logs);
});

test("env:false ignores hostile OTEL destinations, headers, TLS paths and compression", async () => {
  const collector = await startCollector();
  cleanup.push(() => collector.close());
  for (const key of ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]) {
    vi.stubEnv(key, `invalid:${secretKey}`);
  }
  for (const key of ["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"]) {
    vi.stubEnv(key, `Authorization=invalid,evil=${secretKey}`);
  }
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE", `/missing/${secretKey}`);
  vi.stubEnv("OTEL_EXPORTER_OTLP_COMPRESSION", "none");
  vi.stubEnv("LANGFUSE_OTEL_MAX_BATCH_SIZE_BYTES", "1");
  const logs = captureDiagnostics();
  const instance = provider(collector.baseUrl);
  instance.getTracer("fixture").startSpan("test", {}, ROOT_CONTEXT).end();
  await instance.forceFlush();
  const request = await collector.next();
  assert.equal(request.headers.authorization, authorization);
  assert.equal(request.headers.evil, undefined);
  assert.equal(request.headers["content-encoding"], "gzip");
  assertNoCredentials(logs);
});

test("invalid compatibility settings warn without echoing their values", async () => {
  const collector = await startCollector();
  cleanup.push(() => collector.close());
  const logs = captureDiagnostics();
  const instance = provider(collector.baseUrl, {
    LANGFUSE_OTEL_COMPRESSION: secretKey,
    LANGFUSE_OTEL_MAX_BATCH_SIZE_BYTES: authorization,
  });
  instance.getTracer("fixture").startSpan("invalid-settings", {}, ROOT_CONTEXT).end();
  await instance.forceFlush();
  assert.ok(logs.some((args) => inspect(args).includes("Invalid LANGFUSE_OTEL_COMPRESSION")));
  assert.ok(logs.some((args) => inspect(args).includes("Invalid LANGFUSE_OTEL_MAX_BATCH_SIZE_BYTES")));
  assertNoCredentials(logs);
});

test("supports uncompressed OTLP JSON through the compatibility environment control", async () => {
  const collector = await startCollector();
  cleanup.push(() => collector.close());
  const instance = provider(collector.baseUrl, { LANGFUSE_OTEL_COMPRESSION: "none" });
  instance.getTracer("fixture").startSpan("uncompressed", {}, ROOT_CONTEXT).end();
  await instance.forceFlush();
  const request = await collector.next();
  assert.equal(request.headers["content-encoding"], undefined);
  assert.equal(decodeExport(request).resourceSpans[0].scopeSpans[0].spans[0].name, "uncompressed");
});

test("retries Retry-After responses through the standard SDK and exports identical data", async () => {
  const collector = await startCollector((_request, response, index) => {
    if (index === 0) response.writeHead(503, { "retry-after": "Thu, 01 Jan 1970 00:00:00 GMT" }).end();
    else response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  cleanup.push(() => collector.close());
  const instance = provider(collector.baseUrl);
  instance.getTracer("fixture").startSpan("retry", {}, ROOT_CONTEXT).end();
  await instance.forceFlush();
  assert.equal(collector.requests.length, 2);
  assert.deepEqual(decodeExport(collector.requests[0]), decodeExport(collector.requests[1]));
});

test("does not wait or retry when Retry-After exceeds the five-second export budget", async () => {
  const collector = await startCollector((_request, response) => {
    response.writeHead(429, { "retry-after": "60" }).end(secretKey);
  });
  cleanup.push(() => collector.close());
  const logs = captureDiagnostics();
  const instance = provider(collector.baseUrl);
  instance.getTracer("fixture").startSpan("rate-limit", {}, ROOT_CONTEXT).end();
  await assertExportFailure(instance.forceFlush());
  assert.equal(collector.requests.length, 1);
  assertNoCredentials(logs);
});

test("permanent failures are not retried and do not poison the next flush", async () => {
  const collector = await startCollector((_request, response, index) => {
    if (index === 0) response.writeHead(400).end(`${secretKey} ${authorization}`);
    else response.writeHead(200).end("{}");
  });
  cleanup.push(() => collector.close());
  const logs = captureDiagnostics();
  const instance = provider(collector.baseUrl);
  instance.getTracer("fixture").startSpan("failed", {}, ROOT_CONTEXT).end();
  await assertExportFailure(instance.forceFlush());
  assert.equal(collector.requests.length, 1);
  instance.getTracer("fixture").startSpan("recovered", {}, ROOT_CONTEXT).end();
  await instance.forceFlush();
  assert.equal(collector.requests.length, 2);
  assertNoCredentials(logs);
});

test("retries a closed connection without leaving an unsettled export", async () => {
  const collector = await startCollector((_request, response, index) => {
    if (index === 0) response.destroy();
    else response.writeHead(200).end("{}");
  });
  cleanup.push(() => collector.close());
  const logs = captureDiagnostics();
  // Advance only the SDK's random retry delay; leave real HTTP event processing intact.
  const originalTimeout = globalThis.setTimeout;
  const retryDelays: number[] = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (typeof delay === "number" && delay >= 800 && delay <= 1_200) {
      retryDelays.push(delay);
      return originalTimeout(callback, 0, ...args);
    }
    return originalTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
  const instance = provider(collector.baseUrl);
  instance.getTracer("fixture").startSpan("closed", {}, ROOT_CONTEXT).end();
  await instance.forceFlush();
  assert.equal(collector.requests.length, 2);
  assert.equal(retryDelays.length, 1);
  assertNoCredentials(logs);
});

test("bounds the SDK queue without dropping queued batches during a concurrent scheduled export", async () => {
  const responses: (() => void)[] = [];
  const collector = await startCollector((_request, response) => {
    responses.push(() => response.writeHead(200).end("{}"));
  });
  cleanup.push(() => collector.close());
  const instance = provider(collector.baseUrl);
  const tracer = instance.getTracer("fixture");
  // The first full batch exports automatically. Keep it pending while filling the queue.
  for (let index = 0; index < 512; index++) tracer.startSpan("active", {}, ROOT_CONTEXT).end();
  await collector.next();
  for (let index = 0; index < 2_049; index++) tracer.startSpan("queued", {}, ROOT_CONTEXT).end();
  const flush = instance.forceFlush();
  await collector.next(4);
  for (const complete of responses) complete();
  await flush;
  await instance.shutdown();
  assert.equal(collector.requests.length, 5);
  const spans = collector.requests.flatMap((request) =>
    decodeExport(request).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)),
  );
  assert.equal(spans.length, 2_560);
  assert.equal(spans.filter((span) => span.name === "active").length, 512);
  assert.equal(spans.filter((span) => span.name === "queued").length, 2_048);
});

test("shutdown waits for an already pending export and remains idempotent", async () => {
  let complete: (() => void) | undefined;
  const collector = await startCollector((_request, response) => {
    complete = () => response.writeHead(200).end("{}");
  });
  cleanup.push(() => collector.close());
  const instance = provider(collector.baseUrl);
  instance.getTracer("fixture").startSpan("pending", {}, ROOT_CONTEXT).end();
  const flush = instance.forceFlush();
  await collector.next();
  let finished = false;
  const shutdown = instance.shutdown().then(() => {
    finished = true;
  });
  await setImmediate();
  assert.equal(finished, false);
  assert.ok(complete);
  complete();
  await Promise.all([flush, shutdown]);
  await instance.shutdown();
  assert.equal(collector.requests.length, 1);
});

test.each(["malformed", "partial"])("does not log collector-controlled %s response content", async (mode) => {
  const collector = await startCollector((_request, response) => {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(
        mode === "malformed"
          ? `not-json-${secretKey}`
          : JSON.stringify({ partialSuccess: { rejectedSpans: "1", errorMessage: `${secretKey} ${authorization}` } }),
      );
  });
  cleanup.push(() => collector.close());
  const logs = captureDiagnostics();
  const instance = provider(collector.baseUrl);
  instance.getTracer("fixture").startSpan("safe-response", {}, ROOT_CONTEXT).end();
  // Batch completion is not a delivery acknowledgement, including partial success.
  await instance.forceFlush();
  assertNoCredentials(logs);
});
