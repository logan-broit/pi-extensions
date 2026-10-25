import { createHash } from "node:crypto";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { type SpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import type { LangfuseConfig } from "./config.js";
import { createLangfuseProcessor } from "./otel-exporter.js";
import { OtelObservation, safeAttribute } from "./otel-observation.js";
import {
  type CreateLangfuseRuntimeOptions,
  createLangfuseRuntimeFromBackend,
  getLangfuseRuntimeInternal,
  type LangfuseRuntime,
  type LangfuseRuntimeInternal,
} from "./runtime-core.js";
import { DEFAULT_BASE_URL } from "./runtime-defaults.js";
import type { Observation, ObservationAttributes, ObservationType, TraceBackend } from "./tracing.js";

export { maskSecrets } from "./otel-observation.js";
export type { CreateLangfuseRuntimeOptions, LangfuseRuntime, LangfuseRuntimeConfig } from "./runtime-core.js";

const RUNTIME_KEY = Symbol.for("@narumitw/pi-langfuse/runtime/v2");
const LEGACY_RUNTIME_KEY = Symbol.for("@narumitw/pi-langfuse/runtime/v1");

interface ResolvedRuntimeConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment?: string;
  release?: string;
}

interface SharedRuntime {
  fingerprint: string;
  runtime: LangfuseRuntimeInternal;
  shutdown: true;
}

type GlobalWithRuntime = typeof globalThis & {
  [RUNTIME_KEY]?: Promise<SharedRuntime>;
  [LEGACY_RUNTIME_KEY]?: unknown;
};

export interface RuntimeFactories {
  createProcessor(config: ResolvedRuntimeConfig): SpanProcessor;
  createProvider(processor: SpanProcessor): TracerProvider;
}

class ProductionTraceBackend implements TraceBackend {
  private readonly tracer;
  private readonly observations = new WeakSet<OtelObservation>();
  private readonly secrets: readonly string[];

  constructor(
    private readonly provider: TracerProvider,
    private readonly processor: SpanProcessor,
    private readonly config: ResolvedRuntimeConfig,
  ) {
    this.tracer = provider.getTracer("@narumitw/pi-langfuse");
    this.secrets = [
      config.publicKey,
      config.secretKey,
      Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64"),
    ];
  }

  start(
    name: string,
    attributes: ObservationAttributes,
    options: { asType: ObservationType; parent?: Observation; startTime?: Date },
  ): Observation {
    const parent =
      options.parent instanceof OtelObservation && this.observations.has(options.parent) ? options.parent : undefined;
    const context = parent ? trace.setSpanContext(ROOT_CONTEXT, parent.span.spanContext()) : ROOT_CONTEXT;
    const span = this.tracer.startSpan(
      safeAttribute(name, this.secrets),
      {
        startTime: options.startTime,
        attributes: {
          "langfuse.observation.type": options.asType,
          ...(!parent?.recording ? { "langfuse.internal.is_app_root": true } : {}),
          ...(this.config.environment !== undefined
            ? { "langfuse.environment": safeAttribute(this.config.environment, this.secrets) }
            : {}),
          ...(this.config.release !== undefined
            ? { "langfuse.release": safeAttribute(this.config.release, this.secrets) }
            : {}),
        },
      },
      context,
    );
    const observation = new OtelObservation(span, this.secrets);
    this.observations.add(observation);
    return observation.update(attributes);
  }

  async forceFlush(): Promise<void> {
    await this.processor.forceFlush();
  }
  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }
}

export async function createLangfuseRuntime(options: CreateLangfuseRuntimeOptions = {}): Promise<LangfuseRuntime> {
  return createSharedRuntime(resolveLangfuseRuntimeConfig(options), {
    ...defaultFactories,
    createProcessor: (config) => createLangfuseProcessor(config, options.env),
  });
}

export async function createProductionBackend(
  config: LangfuseConfig,
  factoryOverrides: Partial<RuntimeFactories> = {},
): Promise<TraceBackend> {
  const runtime = await createSharedRuntime(resolveLangfuseRuntimeConfig({ config, env: false }), {
    ...defaultFactories,
    ...factoryOverrides,
  });
  return getLangfuseRuntimeInternal(runtime).backend;
}

async function createSharedRuntime(
  config: ResolvedRuntimeConfig,
  factories: RuntimeFactories,
): Promise<LangfuseRuntime> {
  const globals = globalThis as GlobalWithRuntime;
  const fingerprint = configFingerprint(config);
  const existing = globals[RUNTIME_KEY];
  const legacy = globals[LEGACY_RUNTIME_KEY];
  if (legacy !== undefined && legacy !== existing) {
    throw new Error("An older Langfuse runtime is already loaded; restart the process before enabling this version.");
  }
  if (existing) {
    if (legacy === undefined) globals[LEGACY_RUNTIME_KEY] = existing;
    const shared = await existing;
    if (shared.runtime.closed)
      throw new Error("Langfuse tracing was already shut down; restart the process to enable it again.");
    if (shared.fingerprint !== fingerprint)
      throw new Error("Langfuse configuration changed; restart the process to apply the new credentials.");
    return shared.runtime;
  }
  const initializing = initializeRuntime(config, fingerprint, factories);
  globals[RUNTIME_KEY] = initializing;
  globals[LEGACY_RUNTIME_KEY] = initializing;
  try {
    return (await initializing).runtime;
  } catch (error) {
    if (globals[RUNTIME_KEY] === initializing) delete globals[RUNTIME_KEY];
    if (globals[LEGACY_RUNTIME_KEY] === initializing) delete globals[LEGACY_RUNTIME_KEY];
    throw error;
  }
}

async function initializeRuntime(
  config: ResolvedRuntimeConfig,
  fingerprint: string,
  factories: RuntimeFactories,
): Promise<SharedRuntime> {
  const processor = factories.createProcessor(config);
  let provider: TracerProvider | undefined;
  try {
    provider = factories.createProvider(processor);
    const runtime = getLangfuseRuntimeInternal(
      createLangfuseRuntimeFromBackend(new ProductionTraceBackend(provider, processor, config)),
    );
    return { fingerprint, runtime, shutdown: true };
  } catch (error) {
    await (provider?.shutdown() ?? processor.shutdown()).catch(() => undefined);
    throw error;
  }
}

const defaultFactories: RuntimeFactories = {
  // The extension resolves connection fields only from validated JSON. Preserve its
  // documented compression/size environment controls, never generic OTLP destinations.
  createProcessor: (config) => createLangfuseProcessor(config),
  createProvider: (processor) =>
    new TracerProvider({
      spanProcessors: [processor],
      // Reserve enough attributes for both trace and observation metadata plus late updates.
      // Explicit limits prevent ambient OTEL_SPAN_* variables from dropping required fields.
      spanLimits: { attributeCountLimit: 1_024, attributeValueLengthLimit: 65_536 },
    }),
};

export function resolveLangfuseRuntimeConfig(options: CreateLangfuseRuntimeOptions): ResolvedRuntimeConfig {
  const env = options.env === false ? undefined : (options.env ?? process.env);
  const publicKey = requiredSetting("publicKey", options.config?.publicKey, env?.LANGFUSE_PUBLIC_KEY);
  const secretKey = requiredSetting("secretKey", options.config?.secretKey, env?.LANGFUSE_SECRET_KEY);
  const explicitBaseUrl = options.config?.baseUrl;
  if (explicitBaseUrl !== undefined && !normalizeString(explicitBaseUrl))
    throw new Error("Langfuse baseUrl must be a non-empty string.");
  const rawBaseUrl = selectedSetting(explicitBaseUrl, env?.LANGFUSE_BASE_URL) ?? DEFAULT_BASE_URL;
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  if (!baseUrl) throw new Error("Langfuse baseUrl must use HTTP or HTTPS without credentials, a query, or a fragment.");
  const environment = optionalSetting("environment", options.config?.environment, env?.LANGFUSE_TRACING_ENVIRONMENT);
  if (environment && (environment.length > 40 || !/^(?!langfuse)[a-z0-9_-]+$/u.test(environment))) {
    throw new Error(
      "Langfuse environment must be at most 40 lowercase letters, numbers, hyphens, or underscores and must not start with langfuse.",
    );
  }
  const release = optionalSetting("release", options.config?.release, env?.LANGFUSE_RELEASE);
  return { publicKey, secretKey, baseUrl, ...(environment ? { environment } : {}), ...(release ? { release } : {}) };
}

function requiredSetting(name: string, explicit: string | undefined, environment: string | undefined): string {
  const value = selectedSetting(explicit, environment);
  if (!value) throw new Error(`Langfuse ${name} is required.`);
  return value;
}
function optionalSetting(
  name: string,
  explicit: string | undefined,
  environment: string | undefined,
): string | undefined {
  const selected = explicit !== undefined ? explicit : environment;
  if (selected === undefined) return undefined;
  const value = normalizeString(selected);
  if (!value) throw new Error(`Langfuse ${name} must be a non-empty string.`);
  return value;
}
function selectedSetting(explicit: string | undefined, environment: string | undefined): string | undefined {
  return explicit !== undefined ? normalizeString(explicit) : normalizeString(environment);
}
function normalizeBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password || url.href.includes("?") || url.href.includes("#")) return undefined;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}
function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function configFingerprint(config: ResolvedRuntimeConfig): string {
  return createHash("sha256")
    .update(
      `${config.publicKey}\0${config.secretKey}\0${config.baseUrl}\0${config.environment ?? ""}\0${config.release ?? ""}`,
    )
    .digest("hex");
}
