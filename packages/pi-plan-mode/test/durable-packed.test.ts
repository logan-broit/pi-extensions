import { type ChildProcess, execFile, fork } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const exec = promisify(execFile);
let directory: string;
let manifest: {
  main?: string;
  types?: string;
  pi: { extensions: string[] };
  exports: Record<string, string | { types: string; import: string }>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional: boolean }>;
};
let packedFiles: string[];
let consumerCompiled = false;
const children: ChildProcess[] = [];
const consumers: Array<{
  child: ChildProcess;
  completed: Promise<{ code: number | null; stdout: string; stderr: string }>;
}> = [];

async function installPacked(root: string, tarball: string, excluded: string[]) {
  const modules = join(root, "node_modules");
  const installed = join(modules, "@narumitw/pi-plan-mode");
  await mkdir(installed, { recursive: true });
  await exec("tar", ["-xzf", tarball, "--strip-components=1", "-C", installed]);
  // Reuse the exact installed release. These deterministic tests never use npm install or a registry.
  const rootModules = resolve("node_modules");
  for (const entry of await readdir(rootModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      await mkdir(join(modules, entry.name), { recursive: true });
      for (const name of await readdir(join(rootModules, entry.name))) {
        const id = `${entry.name}/${name}`;
        if (id === "@narumitw/pi-plan-mode" || excluded.includes(id)) continue;
        await symlink(join(rootModules, id), join(modules, id), "dir");
      }
    } else await symlink(join(rootModules, entry.name), join(modules, entry.name), "dir");
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  return installed;
}

async function prepareChild(root: string, entry: string, blocked: string[]) {
  const hooks = join(root, "boundary-hooks.mjs");
  await writeFile(
    hooks,
    `
import { registerHooks } from "node:module";
const blocked = ${JSON.stringify(blocked)};
registerHooks({ resolve(specifier, context, next) {
  if (blocked.some((id) => specifier === id || specifier.startsWith(id + "/"))) throw new Error("Forbidden package loaded: " + specifier);
  return next(specifier, context);
} });
`,
  );
  const child = fork(entry, [], {
    execArgv: ["--import", hooks],
    cwd: root,
    silent: true,
    env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") },
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (data) => {
    stdout += String(data);
  });
  child.stderr?.on("data", (data) => {
    stderr += String(data);
  });
  const completed = new Promise<{ code: number | null; stdout: string; stderr: string }>((done) =>
    child.once("close", (code) => done({ code, stdout, stderr })),
  );
  consumers.push({ child, completed });
  await new Promise<void>((ready, reject) => {
    let started = false;
    child.once("message", (message) => {
      if (message === "ready") {
        started = true;
        ready();
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!started) reject(new Error(`Consumer exited before readiness (${code}): ${stderr}`));
    });
  });
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-durable-packed-"));
  const packed = await exec("npm", [
    "pack",
    "--workspace",
    "@narumitw/pi-plan-mode",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    directory,
  ]);
  const [{ filename, files }] = JSON.parse(packed.stdout) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  packedFiles = files.map((file) => file.path);
  const tarball = join(directory, filename);
  const durableRoot = join(directory, "durable");
  const installed = await installPacked(durableRoot, tarball, [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "@narumitw/pi-tui-kit",
  ]);
  manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  for (const id of ["@earendil-works/pi-durable", "@earendil-works/chord"]) {
    const peer = JSON.parse(await readFile(resolve("node_modules", id, "package.json"), "utf8"));
    expect(peer.version).toBe("1.2.0");
  }
  await writeFile(
    join(durableRoot, "consumer.ts"),
    `
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createDurablePlanMode, type DurablePlanController } from "@narumitw/pi-plan-mode/durable";
import type { PlanModeQuestion } from "@narumitw/pi-plan-mode/src/question-domain.js";
const question: PlanModeQuestion | undefined = undefined;
void question;
process.send?.("ready");
await new Promise<void>((done) => process.once("message", () => done()));
process.disconnect?.();
const context = BACKGROUND_CONTEXT;
const registry = createRegistry();
const integration = createDurablePlanMode({ registryVersion: "packed-v1", registry, capabilities: [] });
registry.install(integration.extension);
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: integration.registry }, context);
const controller: DurablePlanController = integration.createController(harness);
try {
  const conversation = await harness.root(context);
  const state = await controller.inspect(conversation, context);
  assert.equal(state.phase, "inactive");
  assert.equal(state.workflowId, null);
  assert.equal(state.forked, false);
  assert.throws(() => import.meta.resolve("@narumitw/pi-plan-mode"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  for (const path of ["src/index.ts", "src/plan-mode.ts", "dist/index.ts", "dist/durable.js", "package.json", "README.md", "LICENSE", "docs/settings.md"]) {
    assert.ok(import.meta.resolve("@narumitw/pi-plan-mode/" + path).endsWith("/" + path), path);
  }
} finally {
  await controller.dispose(context);
  await harness.close(context);
}
console.log("packed durable consumer passed");
`,
  );
  await writeFile(
    join(durableRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        outDir: "out",
      },
      files: ["consumer.ts"],
    }),
  );
  await exec(process.execPath, [
    resolve("node_modules/typescript/lib/tsc.js"),
    "-p",
    join(durableRoot, "tsconfig.json"),
  ]);
  consumerCompiled = true;
  await prepareChild(durableRoot, join(durableRoot, "out/consumer.js"), [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "@narumitw/pi-tui-kit",
  ]);

  const codingRoot = join(directory, "coding");
  await installPacked(codingRoot, tarball, ["@earendil-works/pi-durable", "@earendil-works/chord"]);
  await writeFile(
    join(codingRoot, "consumer.mjs"),
    `
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
process.send?.("ready");
await new Promise((done) => process.once("message", done));
process.disconnect?.();
await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
await assert.rejects(import("@earendil-works/pi-durable"), /Forbidden package loaded/);
const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: SettingsManager.inMemory({}), additionalExtensionPaths: [join(process.cwd(), "node_modules/@narumitw/pi-plan-mode")] });
await loader.reload();
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
assert.ok(loaded.extensions[0].commands.has("plan"));
assert.ok(loaded.extensions[0].handlers.has("session_start"));
assert.ok(loaded.extensions[0].handlers.has("session_shutdown"));
console.log("packed coding consumer passed");
`,
  );
  await prepareChild(codingRoot, join(codingRoot, "consumer.mjs"), [
    "@earendil-works/pi-durable",
    "@earendil-works/chord",
  ]);
}, 30_000);

afterAll(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.all(consumers.map((consumer) => consumer.completed));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("packed metadata preserves one Jiti entry, old file paths, and optional exact durable hosts", () => {
  expect(manifest.pi.extensions).toEqual(["./dist/index.ts"]);
  expect(manifest.main).toBeUndefined();
  expect(manifest.types).toBeUndefined();
  expect(manifest.exports["."]).toBeUndefined();
  expect(manifest.exports["./*"]).toBe("./*");
  expect(manifest.exports["./durable"]).toEqual({ types: "./dist/durable.d.ts", import: "./dist/durable.js" });
  expect(manifest.peerDependencies["@earendil-works/pi-durable"]).toBe("1.2.0");
  expect(manifest.peerDependencies["@earendil-works/chord"]).toBe("^1.2.0");
  for (const name of ["@earendil-works/pi-durable", "@earendil-works/chord"])
    expect(manifest.peerDependenciesMeta[name]).toEqual({ optional: true });
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"])
    expect(manifest.peerDependencies[name]).toBe("*");
  for (const path of [
    "dist/index.ts",
    "dist/durable.js",
    "dist/durable.d.ts",
    "src/index.ts",
    "src/plan-mode.ts",
    "package.json",
    "README.md",
    "LICENSE",
    "docs/settings.md",
  ])
    expect(packedFiles).toContain(path);
  expect(packedFiles.some((file) => file.startsWith("dist/chunks/"))).toBe(true);
});

test("packed public declarations compile with the real pinned host and legacy source subpaths", () => {
  expect(consumerCompiled).toBe(true);
});

test("packed ESM durable entry runs with real hosts and no coding-agent graph", async () => {
  const consumer = consumers[0];
  consumer.child.send("run");
  const result = await consumer.completed;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("packed durable consumer passed");
});

test("packed coding-agent Jiti entry still loads without optional durable hosts", async () => {
  const consumer = consumers[1];
  consumer.child.send("run");
  const result = await consumer.completed;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("packed coding consumer passed");
});
