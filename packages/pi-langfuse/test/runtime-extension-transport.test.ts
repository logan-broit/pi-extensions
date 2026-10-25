import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createProductionBackend } from "../src/runtime.js";
import { decodeExport, startCollector } from "./otel-collector.js";

test("extension preserves documented compression control without ambient credential or destination overrides", async () => {
  const collector = await startCollector();
  vi.stubEnv("LANGFUSE_OTEL_COMPRESSION", "none");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "ambient-public");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "ambient-secret");
  vi.stubEnv("LANGFUSE_BASE_URL", "http://invalid.example");
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "invalid:private-environment");
  vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=private-environment");
  const backend = await createProductionBackend({
    publicKey: "settings-public",
    secretKey: "settings-secret",
    baseUrl: collector.baseUrl,
    captureContent: false,
  });
  try {
    backend.start("uncompressed", {}, { asType: "agent" }).end();
    await backend.forceFlush();
    const request = await collector.next();
    assert.equal(request.headers["content-encoding"], undefined);
    assert.equal(
      request.headers.authorization,
      `Basic ${Buffer.from("settings-public:settings-secret").toString("base64")}`,
    );
    assert.equal(request.url, "/api/public/otel/v1/traces");
    assert.equal(decodeExport(request).resourceSpans[0]?.scopeSpans[0]?.spans[0]?.name, "uncompressed");
  } finally {
    await backend.shutdown();
    vi.unstubAllEnvs();
    const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
    delete globals[Symbol.for("@narumitw/pi-langfuse/runtime/v1")];
    delete globals[Symbol.for("@narumitw/pi-langfuse/runtime/v2")];
    await collector.close();
  }
});
