import assert from "node:assert/strict";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createLangfuseProcessor } from "../src/otel-exporter.js";

interface DelegateOptions {
  url: string;
  headers(): Promise<Record<string, string>>;
  compression: string;
  timeoutMillis: number;
  concurrencyLimit: number;
}

interface ProcessorOptions {
  exporter: SpanExporter;
  maxExportBatchSize: number;
  maxQueueSize: number;
  scheduledDelayMillis: number;
  exportTimeoutMillis: number;
}

const mocks = vi.hoisted(() => ({
  delegateOptions: undefined as DelegateOptions | undefined,
  processorOptions: undefined as ProcessorOptions | undefined,
  export: vi.fn<SpanExporter["export"]>((_spans, callback) => callback({ code: 0 })),
  forceFlush: vi.fn(async () => undefined),
  shutdown: vi.fn(async () => undefined),
}));

vi.mock("@opentelemetry/otlp-exporter-base/node-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opentelemetry/otlp-exporter-base/node-http")>()),
  createOtlpHttpExportDelegate: (options: DelegateOptions) => {
    mocks.delegateOptions = options;
    return { export: mocks.export, forceFlush: mocks.forceFlush, shutdown: mocks.shutdown };
  },
}));

vi.mock("@opentelemetry/sdk-trace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opentelemetry/sdk-trace")>()),
  BatchSpanProcessor: class {
    constructor(options: ProcessorOptions) {
      mocks.processorOptions = options;
    }
  },
}));

const config = { publicKey: "public", secretKey: "secret", baseUrl: "https://example.test/base///" };

function exporter(env: NodeJS.ProcessEnv | false = false): SpanExporter {
  createLangfuseProcessor(config, env);
  assert.ok(mocks.processorOptions);
  return mocks.processorOptions.exporter;
}

function span(fields: Partial<ReadableSpan> = {}): ReadableSpan {
  return { name: "", status: {}, attributes: {}, events: [], links: [], ...fields } as ReadableSpan;
}

function exportResult(instance: SpanExporter, spans: ReadableSpan[]) {
  let result: Parameters<Parameters<SpanExporter["export"]>[1]>[0] | undefined;
  instance.export(spans, (value) => {
    result = value;
  });
  assert.ok(result);
  return result;
}

beforeEach(() => {
  mocks.delegateOptions = undefined;
  mocks.processorOptions = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test("uses explicit endpoint, only required auth/ingestion headers and bounded SDK settings", async () => {
  exporter();
  assert.ok(mocks.delegateOptions && mocks.processorOptions);
  assert.equal(mocks.delegateOptions.url, "https://example.test/base/api/public/otel/v1/traces");
  assert.deepEqual(await mocks.delegateOptions.headers(), {
    "Content-Type": "application/json",
    Authorization: "Basic cHVibGljOnNlY3JldA==",
    "x-langfuse-ingestion-version": "4",
  });
  assert.equal(mocks.delegateOptions.compression, "gzip");
  assert.equal(mocks.delegateOptions.timeoutMillis, 5_000);
  assert.equal(mocks.delegateOptions.concurrencyLimit, 30);
  assert.equal(mocks.processorOptions.maxExportBatchSize, 512);
  assert.equal(mocks.processorOptions.maxQueueSize, 2_048);
  assert.equal(mocks.processorOptions.scheduledDelayMillis, 5_000);
  assert.equal(mocks.processorOptions.exportTimeoutMillis, 5_000);
});

test.each([
  [{}, "gzip"],
  [{ LANGFUSE_OTEL_COMPRESSION: " NoNe ", OTEL_EXPORTER_OTLP_TRACES_COMPRESSION: "gzip" }, "none"],
  [{ LANGFUSE_OTEL_COMPRESSION: "invalid", OTEL_EXPORTER_OTLP_TRACES_COMPRESSION: " NONE " }, "none"],
  [
    {
      LANGFUSE_OTEL_COMPRESSION: "",
      OTEL_EXPORTER_OTLP_TRACES_COMPRESSION: "invalid",
      OTEL_EXPORTER_OTLP_COMPRESSION: "none",
    },
    "none",
  ],
  [{ LANGFUSE_OTEL_COMPRESSION: "gzip", OTEL_EXPORTER_OTLP_TRACES_COMPRESSION: "none" }, "gzip"],
  [{ OTEL_EXPORTER_OTLP_TRACES_COMPRESSION: "gzip", OTEL_EXPORTER_OTLP_COMPRESSION: "none" }, "gzip"],
  [{ LANGFUSE_OTEL_COMPRESSION: "invalid", OTEL_EXPORTER_OTLP_COMPRESSION: "invalid" }, "gzip"],
] as const)("preserves compression precedence for %j", (env, expected) => {
  exporter(env);
  assert.equal(mocks.delegateOptions?.compression, expected);
});

test("env:false ignores process compression and size controls", () => {
  vi.stubEnv("LANGFUSE_OTEL_COMPRESSION", "none");
  vi.stubEnv("LANGFUSE_OTEL_MAX_BATCH_SIZE_BYTES", "1");
  const instance = exporter(false);
  assert.equal(mocks.delegateOptions?.compression, "gzip");
  assert.equal(exportResult(instance, [span({ name: "longer" })]).code, 0);
});

test.each(["https://example.test", "https://example.test/", "https://example.test///", "https://example.test/base/"])(
  "preserves the base path in %s",
  (baseUrl) => {
    createLangfuseProcessor({ ...config, baseUrl }, false);
    assert.equal(mocks.delegateOptions?.url, `${baseUrl.replace(/\/+$/u, "")}/api/public/otel/v1/traces`);
  },
);

test.each([
  "not-a-url-secret",
  "ftp://secret@example.test",
  "https://public:secret@example.test",
  "https://example.test/?secret",
  "https://example.test/#secret",
  "https://example.test/?",
  "https://example.test/#",
])("rejects invalid destination without echoing it: %s", (baseUrl) => {
  assert.throws(
    () => createLangfuseProcessor({ ...config, baseUrl }, false),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("secret"));
      assert.match(error.message, /Langfuse baseUrl must use HTTP or HTTPS/u);
      return true;
    },
  );
  assert.equal(mocks.delegateOptions, undefined);
});

test("retains the inclusive 64 MiB default lower-bound limit", () => {
  const instance = exporter();
  const name = "x".repeat(64 * 1024 * 1024);
  assert.equal(exportResult(instance, [span({ name })]).code, 0);
  assert.equal(exportResult(instance, [span({ name: `${name}x` })]).code, 1);
  assert.equal(mocks.export.mock.calls.length, 1);
});

test.each(["", "0", "-1", "1.5", "1e3", "NaN", "9007199254740992", "secret"])(
  "invalid size setting %j falls back to the default without logging its value",
  (value) => {
    const instance = exporter({ LANGFUSE_OTEL_MAX_BATCH_SIZE_BYTES: value });
    assert.equal(exportResult(instance, [span({ name: "not-dropped" })]).code, 0);
  },
);

test("size guard counts names, status, attributes, events and links, but not numeric values", () => {
  const fixture = span({
    name: "n",
    status: { code: 0, message: "m" },
    attributes: { a: "bc", d: ["ef", 999] },
    events: [{ name: "g", time: [0, 0], attributes: { h: "ij" } }],
    links: [{ context: { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 1 }, attributes: { k: "lm" } }],
  });
  assert.equal(exportResult(exporter({ LANGFUSE_OTEL_MAX_BATCH_SIZE_BYTES: " 15 " }), [fixture]).code, 0);
  const result = exportResult(exporter({ LANGFUSE_OTEL_MAX_BATCH_SIZE_BYTES: "14" }), [fixture]);
  assert.equal(result.code, 1);
  assert.equal(result.error?.message, "Langfuse span batch exceeds the configured byte limit.");
});

test("delegate callback and synchronous failures expose only fixed safe errors", () => {
  const instance = exporter();
  mocks.export.mockImplementationOnce((_spans, callback) => callback({ code: 1, error: new Error("secret") }));
  assert.equal(exportResult(instance, [span()]).error?.message, "Langfuse span export failed.");
  mocks.export.mockImplementationOnce(() => {
    throw new Error("secret");
  });
  assert.equal(exportResult(instance, [span()]).error?.message, "Langfuse span export failed.");
});

test("delegate cleanup failures expose only fixed safe errors", async () => {
  const instance = exporter();
  mocks.forceFlush.mockRejectedValueOnce(new Error("secret"));
  mocks.shutdown.mockRejectedValueOnce(new Error("secret"));
  assert.ok(instance.forceFlush);
  await assert.rejects(instance.forceFlush(), { message: "Langfuse export flush failed." });
  await assert.rejects(instance.shutdown(), { message: "Langfuse exporter shutdown failed." });
});
