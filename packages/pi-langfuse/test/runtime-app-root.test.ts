import assert from "node:assert/strict";
import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  StackContextManager,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { test } from "vitest";
import { OtelObservation } from "../src/otel-observation.js";
import { createProductionBackend } from "../src/runtime.js";
import type { Observation, ObservationType } from "../src/tracing.js";

test("isolated provider marks owned app roots without changing unrelated global tracing", async ({
  onTestFinished,
}) => {
  const exporter = new InMemorySpanExporter();
  const unrelatedExporter = new InMemorySpanExporter();
  const globalProvider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: unrelatedExporter })],
  });
  onTestFinished(async () => {
    context.disable();
    trace.disable();
    await globalProvider.shutdown();
  });
  assert.equal(context.setGlobalContextManager(new StackContextManager().enable()), true);
  assert.equal(trace.setGlobalTracerProvider(globalProvider), true);
  const originalGlobalProvider = trace.getTracerProvider();
  const backend = await createProductionBackend(
    {
      publicKey: "pk-app-root",
      secretKey: "sk-app-root",
      baseUrl: "https://example.test",
      captureContent: true,
    },
    { createProcessor: () => new SimpleSpanProcessor({ exporter }) },
  );
  try {
    const external = trace.getTracer("unrelated").startSpan("external-parent", {}, ROOT_CONTEXT);
    context.with(trace.setSpan(ROOT_CONTEXT, external), () => {
      assert.equal(trace.getSpan(context.active()), external);
      const openRoots: Observation[] = [];
      for (const type of ["agent", "generation", "tool", "span"] satisfies ObservationType[]) {
        const root = backend.start(`root-${type}`, { input: "request", output: "response" }, { asType: type });
        const child = backend.start(`child-${type}`, {}, { asType: type, parent: root });
        const backdated = backend.start(
          `backdated-${type}`,
          {},
          { asType: type, parent: root, startTime: new Date(1_000) },
        );
        child.end();
        backdated.end(2_000);
        openRoots.push(root);
      }
      for (const root of openRoots) root.end();

      for (const [scope, attributes] of [
        ["unrelated", {}],
        ["unrelated-genai", { "gen_ai.operation.name": "chat" }],
        ["openinference.instrumentation.openai", {}],
      ] as const) {
        trace.getTracer(scope).startSpan(scope, { attributes }, ROOT_CONTEXT).end();
      }

      // An observation from another provider must not become an owned explicit parent.
      const foreign = new OtelObservation(external, []);
      backend.start("foreign-parent-root", {}, { asType: "span", parent: foreign }).end();
      external.end();
    });

    // An ended owned parent retains trace linkage but starts a new app-root segment.
    const ended = backend.start("ended-parent", {}, { asType: "agent" });
    ended.end();
    backend.start("late-child", {}, { asType: "span", parent: ended }).end();
    await backend.forceFlush();
    await globalProvider.forceFlush();

    assert.equal(trace.getTracerProvider(), originalGlobalProvider);
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 15);
    for (const span of spans) {
      assert.equal(span.instrumentationScope.name, "@narumitw/pi-langfuse");
      const isRoot =
        span.name.startsWith("root-") || ["foreign-parent-root", "ended-parent", "late-child"].includes(span.name);
      assert.equal(span.attributes["langfuse.internal.is_app_root"], isRoot ? true : undefined, span.name);
      if (span.name.startsWith("root-")) {
        assert.equal(span.parentSpanContext, undefined, span.name);
        assert.notEqual(span.spanContext().traceId, external.spanContext().traceId, span.name);
        assert.equal(span.attributes["langfuse.observation.input"], "request");
        assert.equal(span.attributes["langfuse.observation.output"], "response");
      }
      if (span.name.startsWith("child-") || span.name.startsWith("backdated-")) {
        const type = span.name.slice(span.name.indexOf("-") + 1);
        const root = spans.find((candidate) => candidate.name === `root-${type}`);
        assert.equal(span.parentSpanContext?.spanId, root?.spanContext().spanId, span.name);
        assert.equal(span.spanContext().traceId, root?.spanContext().traceId, span.name);
        if (span.name.startsWith("backdated-")) {
          assert.deepEqual(span.startTime, [1, 0]);
          assert.deepEqual(span.endTime, [2, 0]);
        }
      }
    }
    const rootIds = spans.filter((span) => span.name.startsWith("root-")).map((span) => span.spanContext().traceId);
    assert.equal(new Set(rootIds).size, 4, "concurrent roots must remain independent");
    const foreignRoot = spans.find((span) => span.name === "foreign-parent-root");
    assert.ok(foreignRoot);
    assert.equal(foreignRoot.parentSpanContext, undefined);
    assert.notEqual(foreignRoot.spanContext().traceId, external.spanContext().traceId);
    const endedSpan = spans.find((span) => span.name === "ended-parent");
    const lateChild = spans.find((span) => span.name === "late-child");
    assert.ok(endedSpan);
    assert.equal(lateChild?.parentSpanContext?.spanId, endedSpan.spanContext().spanId);
    assert.equal(lateChild?.spanContext().traceId, endedSpan.spanContext().traceId);
    assert.deepEqual(
      unrelatedExporter
        .getFinishedSpans()
        .map((span) => span.name)
        .sort(),
      ["external-parent", "openinference.instrumentation.openai", "unrelated", "unrelated-genai"],
    );
    assert.equal(trace.getSpan(ROOT_CONTEXT), undefined);

    await backend.shutdown();
    trace.getTracer("unrelated").startSpan("after-isolated-shutdown", {}, ROOT_CONTEXT).end();
    await globalProvider.forceFlush();
    assert.ok(unrelatedExporter.getFinishedSpans().some((span) => span.name === "after-isolated-shutdown"));
  } finally {
    await backend.shutdown();
  }
});
