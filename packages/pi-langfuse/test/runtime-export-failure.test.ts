import assert from "node:assert/strict";
import { test } from "vitest";
import { createLangfuseRuntime, createProductionBackend, resolveLangfuseRuntimeConfig } from "../src/runtime.js";
import { startCollector } from "./otel-collector.js";

test("public runtime preserves single export errors and recovers on the next flush", async () => {
  const collector = await startCollector((_request, response, index) => {
    response.writeHead(index === 0 ? 400 : 200).end(index === 0 ? "private-server-error" : "{}");
  });
  const config = {
    publicKey: "pk-failure",
    secretKey: "sk-failure",
    baseUrl: collector.baseUrl,
    captureContent: false,
  };
  const backend = await createProductionBackend(config);
  const runtime = await createLangfuseRuntime({ config, env: false });
  try {
    backend.start("failed", {}, { asType: "span" }).end();
    await assert.rejects(runtime.flush(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Langfuse span export failed.");
      return true;
    });
    backend.start("recovered", {}, { asType: "span" }).end();
    await runtime.flush();
    assert.equal(collector.requests.length, 2);
    await Promise.all([runtime.shutdown(), runtime.shutdown()]);
    assert.equal(runtime.closed, true);
  } finally {
    await runtime.shutdown().catch(() => undefined);
    const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
    delete globals[Symbol.for("@narumitw/pi-langfuse/runtime/v1")];
    delete globals[Symbol.for("@narumitw/pi-langfuse/runtime/v2")];
    await collector.close();
  }
});

for (const suffix of ["?", "#", "?query=value", "#fragment"]) {
  test(`runtime rejects URL delimiter ${suffix} before exporter creation`, () => {
    assert.throws(
      () =>
        resolveLangfuseRuntimeConfig({
          env: false,
          config: { publicKey: "pk", secretKey: "sk", baseUrl: `https://example.test/${suffix}` },
        }),
      /without credentials, a query, or a fragment/,
    );
  });
}
