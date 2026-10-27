import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { type SessionBeforeCompactEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { latestCheckpoint } from "../src/checkpoint.js";
import { DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";

const model: Model<"openai-responses"> = {
  id: "gpt-5.5",
  name: "Unary checkpoint fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.test/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
};
const output = [
  {
    type: "message",
    id: "msg_developer_first",
    role: "developer",
    status: "completed",
    content: [{ type: "input_text", text: "retained instructions, not the current system prompt" }],
  },
  {
    type: "message",
    id: "msg_user",
    role: "user",
    status: "completed",
    content: [{ type: "input_text", text: "retained user history" }],
  },
  {
    type: "message",
    id: "msg_developer_last",
    role: "developer",
    status: "completed",
    content: [{ type: "input_image", file_id: "file_fixture", detail: "high" }],
  },
  { type: "compaction", id: "cmp_fixture", encrypted_content: "opaque-fixture" },
];

// Exercise publication, disk restoration, and both ordinary and maintenance replay.
// Direct adapter-to-adapter replay would bypass the production retention policy.
test("unary developer/user window survives publication, resume, request replay and repeated compaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-unary-checkpoint-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  try {
    vi.resetModules();
    const { createCodexCompactExtension } = await import("../src/codex-compact.js");
    const specifier = "@earendil-works/pi-ai/providers/openai";
    const { openaiProvider } = (await import(specifier)) as { openaiProvider(): Provider };
    const provider = openaiProvider();
    const session = SessionManager.create(directory, directory);
    session.appendMessage({ role: "user", content: "old history", timestamp: 1 });
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const keptId = session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "kept answer" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: "stop",
      timestamp: 2,
    });
    const state = {
      kind: "loaded" as const,
      path: join(directory, "unused.json"),
      document: {},
      settings: {
        ...DEFAULT_CODEX_COMPACT_SETTINGS,
        protocol: "responses-compact" as const,
        checkpointRecovery: "cancel" as const,
        maxRetries: 0,
      },
    };
    const requests: Array<{ input: unknown[] }> = [];
    function runtime(current: SessionManager) {
      const mock = createMockPi();
      createCodexCompactExtension({
        settingsRuntime: {
          get: () => state,
          reload: async () => state,
          update: async () => state,
          flush: async () => {},
        },
        fetch: async (input, init) => {
          assert.equal(String(input), "https://example.test/v1/responses/compact");
          requests.push(JSON.parse(String(init?.body)));
          return Response.json({ output, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } });
        },
      })(mock.pi);
      const { ctx } = createMockContext({
        model,
        sessionManager: current,
        getSystemPrompt: () => "current instructions",
        modelRegistry: {
          getProvider: () => provider,
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
        },
      });
      return { mock, ctx };
    }
    function compactEvent(current: SessionManager): SessionBeforeCompactEvent {
      return {
        type: "session_before_compact",
        reason: "manual",
        willRetry: false,
        branchEntries: current.getBranch(),
        signal: new AbortController().signal,
        preparation: {
          firstKeptEntryId: keptId,
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 100,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
          settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
        },
      };
    }
    const first = runtime(session);
    await first.mock.events.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, first.ctx);
    const result = (await first.mock.events.get("session_before_compact")?.[0]?.(compactEvent(session), first.ctx)) as {
      compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown };
    };
    assert.ok(result?.compaction, "unary compaction must publish rather than fall back");
    session.appendCompaction(
      result.compaction.summary,
      result.compaction.firstKeptEntryId,
      result.compaction.tokensBefore,
      result.compaction.details,
      true,
    );
    session.appendMessage({ role: "user", content: "later question", timestamp: 3 });
    await first.mock.events.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "reload" }, first.ctx);
    const path = session.getSessionFile();
    assert.ok(path);
    const restored = SessionManager.open(path, directory);
    const fresh = runtime(restored);
    await fresh.mock.events.get("session_start")?.[0]?.({ type: "session_start", reason: "resume" }, fresh.ctx);
    const messages = restored.buildSessionContext().messages;
    const projected = (await fresh.mock.events.get("context")?.[0]?.({ type: "context", messages }, fresh.ctx)) as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    const leading = { role: "developer", content: [{ type: "input_text", text: "current instructions" }] };
    const tail = { role: "user", content: [{ type: "input_text", text: "later question" }] };
    const payload = {
      model: model.id,
      tools: [{ type: "function", name: "read" }],
      input: [
        leading,
        { role: "user", content: [{ type: "input_text", text: projected.messages[0].content[0].text }] },
        tail,
      ],
    };
    const replay = (await fresh.mock.events.get("before_provider_request")?.[0]?.(
      { type: "before_provider_request", payload },
      fresh.ctx,
    )) as typeof payload;
    assert.deepEqual(replay.input, [leading, ...output, tail]);
    assert.deepEqual(replay.tools, payload.tools);
    assert.deepEqual(latestCheckpoint(restored.getBranch())?.details.replacementHistory, output);
    const nextTail = { role: "user", content: [{ type: "input_text", text: "another question" }] };
    const next = (await fresh.mock.events.get("before_provider_request")?.[0]?.(
      { type: "before_provider_request", payload: { ...payload, input: [...payload.input, nextTail] } },
      fresh.ctx,
    )) as typeof payload;
    assert.deepEqual(next.input, [...replay.input, nextTail]);
    const repeated = await fresh.mock.events.get("session_before_compact")?.[0]?.(compactEvent(restored), fresh.ctx);
    assert.ok(repeated);
    assert.deepEqual(requests[1]?.input.slice(1, 1 + output.length), output);
    await fresh.mock.events.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "exit" }, fresh.ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
});
