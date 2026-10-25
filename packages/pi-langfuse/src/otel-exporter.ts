import { diag } from "@opentelemetry/api";
import { OTLPExporterBase } from "@opentelemetry/otlp-exporter-base";
import { createOtlpHttpExportDelegate, httpAgentFactoryFromOptions } from "@opentelemetry/otlp-exporter-base/node-http";
import { JsonTraceSerializer, TraceExporterMetricsHelper } from "@opentelemetry/otlp-transformer";
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace";

const DEFAULT_MAX_BATCH_SIZE_BYTES = 64 * 1024 * 1024;
const EXPORT_FAILED = 1;

type ExportCallback = Parameters<SpanExporter["export"]>[1];

/** Creates only the package-owned processor; it does not register global telemetry. */
export function createLangfuseProcessor(
  config: { publicKey: string; secretKey: string; baseUrl: string; environment?: string; release?: string },
  env: NodeJS.ProcessEnv | false = process.env,
): SpanProcessor {
  const url = exportUrl(config.baseUrl);
  const compression = resolveCompression(env);
  const maxBatchSizeBytes = resolveMaxBatchSizeBytes(env);
  const authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`, "utf8").toString("base64")}`;

  // The stock HTTP exporter eagerly reads process.env, even with explicit options,
  // and logs arbitrary response text. Use its public delegate with explicit options
  // and a safe response decoder; the SDK still owns serialization, retries and IO.
  // A host that enables OTel diagnostics can still see SDK transport messages,
  // including server-supplied HTTP status text; callback errors below omit it.
  const delegate = new OTLPExporterBase<ReadableSpan[]>(
    createOtlpHttpExportDelegate(
      {
        url,
        headers: async () => ({
          "Content-Type": "application/json",
          Authorization: authorization,
          "x-langfuse-ingestion-version": "4",
        }),
        compression,
        timeoutMillis: 5_000,
        concurrencyLimit: 30,
        // The SDK HTTP transport has no agent cleanup. Do not retain idle sockets.
        agentFactory: httpAgentFactoryFromOptions({ keepAlive: false }),
      },
      {
        serializeRequest: JsonTraceSerializer.serializeRequest,
        deserializeResponse: safeResponse,
      },
      "otlp_http_span_exporter",
      TraceExporterMetricsHelper,
      undefined,
    ),
  );

  const exporter: SpanExporter = {
    export(spans, callback) {
      // Preserve the former guard: this counts UTF-16 code units, not wire bytes,
      // and deliberately excludes numeric values and resource/scope overhead.
      if (batchSizeLowerBound(spans) > maxBatchSizeBytes) {
        failed(callback, "Langfuse span batch exceeds the configured byte limit.");
        return;
      }
      try {
        delegate.export(spans, (result) => {
          if (result.code === EXPORT_FAILED) failed(callback);
          else callback(result);
        });
      } catch {
        failed(callback);
      }
    },
    async forceFlush() {
      try {
        await delegate.forceFlush();
      } catch {
        throw new Error("Langfuse export flush failed.");
      }
    },
    async shutdown() {
      try {
        await delegate.shutdown();
      } catch {
        throw new Error("Langfuse exporter shutdown failed.");
      }
    },
  };

  return new BatchSpanProcessor({
    exporter,
    maxExportBatchSize: 512,
    maxQueueSize: 2_048,
    scheduledDelayMillis: 5_000,
    exportTimeoutMillis: 5_000,
  });
}

function failed(callback: ExportCallback, message = "Langfuse span export failed."): void {
  callback({ code: EXPORT_FAILED, error: new Error(message) });
}

function exportUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.includes("?") ||
      url.href.includes("#")
    ) {
      throw new Error();
    }
    return `${url.toString().replace(/\/+$/u, "")}/api/public/otel/v1/traces`;
  } catch {
    throw new Error("Langfuse baseUrl must use HTTP or HTTPS without credentials, a query, or a fragment.");
  }
}

function resolveCompression(env: NodeJS.ProcessEnv | false): "gzip" | "none" {
  if (env !== false) {
    for (const key of [
      "LANGFUSE_OTEL_COMPRESSION",
      "OTEL_EXPORTER_OTLP_TRACES_COMPRESSION",
      "OTEL_EXPORTER_OTLP_COMPRESSION",
    ]) {
      const value = env[key]?.trim().toLowerCase();
      if (value === "gzip" || value === "none") return value;
      if (key === "LANGFUSE_OTEL_COMPRESSION" && value) {
        diag.warn("Invalid LANGFUSE_OTEL_COMPRESSION; using the next compression setting.");
      }
    }
  }
  return "gzip";
}

function resolveMaxBatchSizeBytes(env: NodeJS.ProcessEnv | false): number {
  const value = env === false ? undefined : env.LANGFUSE_OTEL_MAX_BATCH_SIZE_BYTES?.trim();
  const parsed = value && /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  if (value) diag.warn("Invalid LANGFUSE_OTEL_MAX_BATCH_SIZE_BYTES; using the default limit.");
  return DEFAULT_MAX_BATCH_SIZE_BYTES;
}

function batchSizeLowerBound(spans: ReadableSpan[]): number {
  let size = 0;
  for (const span of spans) {
    size += span.name.length + (span.status.message?.length ?? 0) + attributesSize(span.attributes);
    for (const event of span.events) size += event.name.length + attributesSize(event.attributes);
    for (const link of span.links) size += attributesSize(link.attributes);
  }
  return size;
}

function attributesSize(attributes: ReadableSpan["attributes"] = {}): number {
  let size = 0;
  for (const [key, value] of Object.entries(attributes)) {
    size += key.length;
    if (typeof value === "string") size += value.length;
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") size += item.length;
    }
  }
  return size;
}

function safeResponse(data: Uint8Array): { partialSuccess?: { rejectedSpans: number } } {
  // Do not pass collector-supplied messages or malformed JSON to SDK diagnostics.
  try {
    const response: unknown = JSON.parse(Buffer.from(data).toString("utf8"));
    if (response && typeof response === "object" && "partialSuccess" in response) {
      const partial = response.partialSuccess;
      if (partial && typeof partial === "object" && "rejectedSpans" in partial) {
        const count = Number(partial.rejectedSpans);
        if (Number.isSafeInteger(count) && count > 0) return { partialSuccess: { rejectedSpans: count } };
      }
    }
  } catch {
    // Like the standard exporter, a malformed success response does not fail export.
  }
  return {};
}
