#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [tarball, compiler = join(root, "node_modules/typescript/lib/tsc.js"), ...extra] = process.argv.slice(2);
assert.ok(
  tarball && isAbsolute(tarball) && extra.length === 0,
  "Usage: node packages/pi-langfuse/scripts/smoke-packed.mjs /absolute/package.tgz [/absolute/tsc.js]",
);
assert.ok(isAbsolute(compiler), "The TypeScript compiler path must be absolute.");
assert.ok((await lstat(tarball)).isFile(), "Supply an actual package tarball, not a symlink or directory.");
assert.ok((await lstat(compiler)).isFile(), "Build/install the repository TypeScript compiler first.");

const directory = await mkdtemp(join(tmpdir(), "pi-langfuse-packed-smoke-"));
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("Packed smoke interrupted."));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
// Do not inherit Node preload hooks or alternate module search paths into the consumer.
const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.NODE_PATH;

async function run(command, args, { handshake = false } = {}) {
  abort.signal.throwIfAborted();
  const child = spawn(command, args, {
    cwd: directory,
    env,
    stdio: handshake ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let deadline;
  let timedOut = false;
  let ready = false;
  const kill = () => child.kill("SIGKILL");
  abort.signal.addEventListener("abort", kill, { once: true });
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  child.on("message", (message) => {
    if (message !== "ready" || ready) return;
    ready = true;
    // Start the execution deadline only after the native child is ready.
    deadline = setTimeout(() => {
      timedOut = true;
      kill();
    }, 30_000);
    child.send("run");
  });
  try {
    await new Promise((resolveRun, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (abort.signal.aborted) reject(abort.signal.reason);
        else if (timedOut) reject(new Error("Packed consumer exceeded its 30-second execution deadline."));
        else if (code !== 0 || (handshake && !ready))
          reject(new Error(`${command} failed (${code ?? signal}):\n${stdout}\n${stderr}`));
        else resolveRun();
      });
    });
    return { stdout, stderr };
  } finally {
    clearTimeout(deadline);
    abort.signal.removeEventListener("abort", kill);
  }
}

try {
  await copyFile(join(root, ".npmrc"), join(directory, ".npmrc"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const installFlags = ["--ignore-scripts", "--omit=dev", "--omit=peer"];
  // Suppress automatic peers and install only each entrypoint's documented host dependencies.
  await run("npm", ["install", tarball, ...installFlags]);
  const manifest = JSON.parse(
    await readFile(join(directory, "node_modules/@narumitw/pi-langfuse/package.json"), "utf8"),
  );
  function testedPeer(name) {
    const version = manifest.devDependencies[name];
    assert.match(version, /^\d+\.\d+\.\d+$/u, `Expected an exact tested ${name} version.`);
    return `${name}@${version}`;
  }
  await run("npm", ["install", testedPeer("@earendil-works/pi-coding-agent"), ...installFlags]);
  await writeFile(join(directory, "consumer.mjs"), `await (${nativeConsumer.toString()})();\n`);
  await run(process.execPath, [join(directory, "consumer.mjs"), "root"], { handshake: true });

  // Durable has separate documented host peers. Use tested versions, not repository links.
  await run("npm", [
    "install",
    ...["@earendil-works/chord", "@earendil-works/pi-durable"].map(testedPeer),
    ...installFlags,
  ]);
  await run(process.execPath, [join(directory, "consumer.mjs"), "durable"], { handshake: true });
  await writeFile(join(directory, "consumer.mts"), declarationConsumer());
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
        lib: ["ES2022"],
      },
      files: ["consumer.mts"],
    }),
  );
  await run(process.execPath, [compiler, "-p", join(directory, "tsconfig.json")]);
  console.log(
    "Packed smoke passed: independent install, entry-specific host peers, OTLP JSON/gzip hierarchy and privacy, Durable import, public declarations.",
  );
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await rm(directory, { recursive: true, force: true });
}

async function nativeConsumer() {
  const { default: assert } = await import("node:assert/strict");
  const { once } = await import("node:events");
  const { createServer } = await import("node:http");
  const { gunzipSync } = await import("node:zlib");
  process.send("ready");
  await once(process, "message");
  process.disconnect();

  if (process.argv[2] === "durable") {
    const durable = await import("@narumitw/pi-langfuse/durable");
    assert.equal(typeof durable.createPiLangfuseDurableConversation, "function");
    assert.equal(typeof durable.createLangfuseRuntimeFromBackend, "function");
    await assert.rejects(durable.createLangfuseRuntime({ env: false }), /publicKey is required/u);
    return;
  }

  for (const peer of ["@earendil-works/pi-durable", "@earendil-works/chord"]) {
    assert.throws(() => import.meta.resolve(peer), { code: "ERR_MODULE_NOT_FOUND" });
  }
  const { default: extension, createLangfuseRuntime, createPiLangfuseSession } = await import("@narumitw/pi-langfuse");
  assert.equal(typeof extension, "function");
  await assert.rejects(createLangfuseRuntime({ env: false }), /publicKey is required/u);

  const publicKey = "pk-packed-smoke";
  const secretKey = "sk-packed-smoke";
  const basic = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const requests = [];
  let collectorError;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.equal(request.url, "/packed/api/public/otel/v1/traces");
      assert.equal(request.headers.authorization, `Basic ${basic}`);
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(request.headers["content-encoding"], "gzip");
      assert.equal(request.headers["x-langfuse-ingestion-version"], "4");
      requests.push(JSON.parse(gunzipSync(Buffer.concat(chunks)).toString("utf8")));
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    } catch (error) {
      collectorError = error;
      response.writeHead(400).end();
    }
  });
  let runtime;
  let session;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    runtime = await createLangfuseRuntime({
      env: false,
      config: {
        publicKey,
        secretKey,
        baseUrl: `http://127.0.0.1:${server.address().port}/packed/`,
        environment: "smoke",
        release: "packed-release",
      },
    });
    for (const captureContent of [true, false]) {
      const start = requests.length;
      const traceIds = [];
      session = createPiLangfuseSession(runtime, {
        captureContent,
        traceName: "packed-trace",
        sessionId: "packed-session",
        userId: "packed-user",
        tags: ["packed"],
        metadata: { tenant: "packed-tenant", nested: { ok: true }, note: secretKey },
        onTraceId: (id) => traceIds.push(id),
      });
      const callbacks = new Map();
      const pi = {
        on(name, callback) {
          const handlers = callbacks.get(name) ?? [];
          handlers.push(callback);
          callbacks.set(name, handlers);
          return () =>
            callbacks.set(
              name,
              handlers.filter((handler) => handler !== callback),
            );
        },
        async exec() {
          return { code: 1, stdout: "", stderr: "", killed: false };
        },
        getThinkingLevel() {
          return "off";
        },
      };
      const ctx = {
        cwd: process.cwd(),
        mode: "json",
        hasUI: false,
        model: { provider: "synthetic", id: "packed-model", api: "synthetic-api" },
        sessionManager: { getSessionId: () => "fallback-session", getLeafId: () => "packed-leaf" },
        getContextUsage: () => ({ tokens: 3, contextWindow: 4096, percent: 0.1 }),
      };
      async function emit(type, event = {}) {
        const handlers = callbacks.get(type);
        assert.ok(handlers?.length, `No public lifecycle callback registered for ${type}.`);
        for (const callback of handlers) await callback({ type, ...event }, ctx);
      }
      await session.extension(pi);
      await emit("session_start");
      session.setRequestId("packed-request");
      const prompt = `private-prompt-marker ${publicKey} data:image/png;base64,cGFja2VkLW1lZGlh`;
      await emit("before_agent_start", { messageType: "user", prompt, images: [], systemPrompt: "synthetic system" });
      await emit("agent_start");
      let assistant;
      for (const turnIndex of [0, 1]) {
        await emit("turn_start", { turnIndex, timestamp: Date.now() });
        await emit("before_provider_request", { payload: { prompt, apiKey: secretKey } });
        await emit("after_provider_response", {
          status: 200,
          headers: { "x-request-id": "synthetic-response", authorization: "private-header-marker" },
        });
        assistant = {
          role: "assistant",
          provider: "synthetic",
          api: "synthetic-api",
          model: "packed-model",
          timestamp: Date.now(),
          content:
            turnIndex === 0
              ? [{ type: "toolCall", id: "packed-tool", name: "synthetic", arguments: { text: "private-tool-marker" } }]
              : [{ type: "text", text: `private-answer-marker ${secretKey} data:image/png;base64,cGFja2VkLW1lZGlh` }],
          usage: {
            input: 2,
            output: 1,
            totalTokens: 3,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0.01, output: 0.02, total: 0.03 },
          },
          stopReason: turnIndex === 0 ? "toolUse" : "stop",
        };
        await emit("message_start", { message: assistant });
        await emit("message_end", { message: assistant });
        const toolResults = [];
        if (turnIndex === 0) {
          await emit("tool_execution_start", {
            toolCallId: "packed-tool",
            toolName: "synthetic",
            args: { text: "private-tool-marker" },
          });
          const result = {
            content: [{ type: "text", text: "private-tool-result-marker" }],
            details: { apiKey: secretKey },
          };
          await emit("tool_execution_end", {
            toolCallId: "packed-tool",
            toolName: "synthetic",
            result,
            isError: false,
          });
          toolResults.push({
            role: "toolResult",
            toolCallId: "packed-tool",
            toolName: "synthetic",
            ...result,
            isError: false,
            timestamp: Date.now(),
          });
        }
        await emit("turn_end", { turnIndex, message: assistant, toolResults });
      }
      await emit("agent_end", { messages: [assistant] });
      await emit("agent_settled");
      await emit("session_shutdown", { reason: "quit" });
      await session.dispose();
      await session.dispose();
      session = undefined;
      await runtime.flush();
      if (collectorError) throw collectorError;
      const bodies = requests.slice(start);
      assert.ok(bodies.length > 0, "Flush did not reach the loopback collector.");
      const scopes = bodies.flatMap((body) => body.resourceSpans.flatMap((resource) => resource.scopeSpans));
      assert.ok(scopes.every((scope) => scope.scope.name === "@narumitw/pi-langfuse"));
      const spans = scopes.flatMap((scope) => scope.spans);
      assert.deepEqual(spans.map((span) => span.name).sort(), [
        "pi.agent",
        "pi.attempt",
        "pi.llm",
        "pi.llm",
        "pi.tool.synthetic",
        "pi.turn",
        "pi.turn",
      ]);
      const attrs = (span) =>
        Object.fromEntries(
          span.attributes.map(({ key, value }) => [
            key,
            value.stringValue ?? value.boolValue ?? value.arrayValue?.values.map((entry) => entry.stringValue),
          ]),
        );
      const roots = spans.filter((span) => !span.parentSpanId);
      assert.equal(roots.length, 1);
      const agent = roots[0];
      assert.equal(agent.name, "pi.agent");
      assert.equal(agent.traceId, traceIds[0]);
      assert.equal(traceIds.length, 1);
      assert.match(agent.traceId, /^[0-9a-f]{32}$/u);
      assert.equal(new Set(spans.map((span) => span.spanId)).size, spans.length);
      const rootAttrs = attrs(agent);
      assert.equal(rootAttrs["langfuse.internal.is_app_root"], true);
      assert.equal(rootAttrs["langfuse.observation.type"], "agent");
      assert.equal(rootAttrs["langfuse.trace.name"], "packed-trace");
      assert.deepEqual(rootAttrs["langfuse.trace.tags"], ["pi", "packed"]);
      assert.equal(rootAttrs["langfuse.version"], "2");
      assert.equal(rootAttrs["langfuse.observation.metadata.tenant"], '"packed-tenant"');
      assert.equal(rootAttrs["langfuse.observation.metadata.nested"], '{"ok":true}');
      assert.equal(rootAttrs["langfuse.observation.metadata.pi.request.id"], '"packed-request"');
      assert.equal(rootAttrs["langfuse.observation.metadata.pi.trace.outcome"], '"success"');
      assert.equal(rootAttrs["langfuse.observation.metadata.note"], '"[LANGFUSE_KEY_REDACTED]"');
      const byId = new Map(spans.map((span) => [span.spanId, span]));
      const parentNames = {
        "pi.attempt": "pi.agent",
        "pi.turn": "pi.attempt",
        "pi.llm": "pi.turn",
        "pi.tool.synthetic": "pi.turn",
      };
      for (const span of spans) {
        const values = attrs(span);
        assert.equal(span.traceId, agent.traceId);
        assert.equal(values["session.id"], "packed-session");
        assert.equal(values["user.id"], "packed-user");
        assert.equal(values["langfuse.environment"], "smoke");
        assert.equal(values["langfuse.release"], "packed-release");
        assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
        if (span !== agent) {
          assert.equal(values["langfuse.internal.is_app_root"], undefined);
          assert.equal(byId.get(span.parentSpanId)?.name, parentNames[span.name]);
        }
        if (span.name === "pi.llm") {
          assert.equal(values["langfuse.observation.type"], "generation");
          assert.equal(values["langfuse.observation.model.name"], "packed-model");
          assert.equal(JSON.parse(values["langfuse.observation.usage_details"]).total, 3);
          assert.equal(JSON.parse(values["langfuse.observation.cost_details"]).total, 0.03);
        }
      }
      const serialized = JSON.stringify(bodies);
      for (const secret of [publicKey, secretKey, basic, "cGFja2VkLW1lZGlh", "private-header-marker"]) {
        assert.equal(serialized.includes(secret), false, "A credential or media marker escaped into OTLP.");
      }
      for (const marker of [
        "private-prompt-marker",
        "private-answer-marker",
        "private-tool-marker",
        "private-tool-result-marker",
      ]) {
        assert.equal(serialized.includes(marker), captureContent, "Content capture policy was not preserved.");
      }
      assert.ok(serialized.includes(captureContent ? "[base64 data URI omitted]" : "[content capture disabled]"));
    }
    await Promise.all([runtime.shutdown(), runtime.shutdown()]);
    assert.equal(runtime.closed, true);
    await assert.rejects(runtime.flush(), /closed|shutting down/u);
    if (collectorError) throw collectorError;
  } finally {
    try {
      await session?.dispose();
    } finally {
      try {
        await runtime?.shutdown();
      } finally {
        if (server.listening) {
          const closed = new Promise((resolveClose, reject) =>
            server.close((error) => (error ? reject(error) : resolveClose())),
          );
          server.closeAllConnections();
          await closed;
        }
      }
    }
  }
}

function declarationConsumer() {
  return `
import extension, {
  createLangfuseRuntime, createPiLangfuseSession,
  type LangfuseRuntime, type PiLangfuseSession, type PiLangfuseSessionOptions,
} from "@narumitw/pi-langfuse";
import {
  createLangfuseRuntime as createDurableRuntime, createLangfuseRuntimeFromBackend,
  createPiLangfuseDurableConversation, type PiLangfuseDurableOptions,
  type PiLangfuseDurableConversation, type TraceBackend,
} from "@narumitw/pi-langfuse/durable";
const runtime: LangfuseRuntime = await createLangfuseRuntime({ env: false, config: {
  publicKey: "fake", secretKey: "fake", baseUrl: "http://127.0.0.1", environment: "smoke",
} });
const options: PiLangfuseSessionOptions = { captureContent: false, onTraceId: (id: string) => { id.toUpperCase(); } };
const session: PiLangfuseSession = createPiLangfuseSession(runtime, options);
session.setRequestId("request");
await session.dispose();
await runtime.flush();
await runtime.shutdown();
const backend: TraceBackend = {
  start(_name, _attributes, _options) { return { update() { return this; }, end() { return this; } }; },
  async forceFlush() {}, async shutdown() {},
};
const customRuntime: LangfuseRuntime = createLangfuseRuntimeFromBackend(backend);
const durableRuntime: LangfuseRuntime = await createDurableRuntime({ env: false });
async function attach(options: PiLangfuseDurableOptions): Promise<PiLangfuseDurableConversation> {
  return createPiLangfuseDurableConversation(customRuntime, options);
}
void [extension, session.extension, durableRuntime, attach];
// A consumer must receive concrete public option types, not an untyped JS surface.
// @ts-expect-error captureContent is a boolean.
createPiLangfuseSession(runtime, { captureContent: "false" });
// @ts-expect-error publicKey is a string.
createLangfuseRuntime({ config: { publicKey: 123 } });
`;
}
