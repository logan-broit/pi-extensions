import type { Span } from "@opentelemetry/api";
import { sanitizeTraceValue } from "./sanitizer.js";
import type { Observation, ObservationAttributes } from "./tracing.js";

// Langfuse's documented OTLP attributes. Keep wire fixtures independent of these names.
// https://langfuse.com/integrations/native/opentelemetry
const OBSERVATION = "langfuse.observation";
const TRACE = "langfuse.trace";
const FAILED = "<failed to serialize>";

export function maskSecrets(data: unknown, secrets: readonly string[]): unknown {
  return maskValue(data, secrets, new WeakSet<object>(), 0);
}

function maskValue(data: unknown, secrets: readonly string[], active: WeakSet<object>, depth: number): unknown {
  if (typeof data === "string") {
    let masked = data;
    // Match whole configured values first, including overlapping or nonstandard keys.
    for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
      masked = masked.replaceAll(secret, "[LANGFUSE_KEY_REDACTED]");
    }
    return masked.replace(/\b(?:sk|pk)-lf-[A-Za-z0-9_-]+\b/g, "[LANGFUSE_KEY_REDACTED]");
  }
  if (!data || typeof data !== "object") return data;
  if (active.has(data)) return "[circular]";
  if (depth >= 16) return "[maximum depth reached]";
  active.add(data);
  try {
    if (Array.isArray(data)) {
      const items = data.slice(0, 200).map((item) => maskValue(item, secrets, active, depth + 1));
      if (data.length > 200) items.push(`[${data.length - 200} items omitted]`);
      return items;
    }
    const entries = Object.entries(data);
    const masked = Object.fromEntries(
      entries
        .slice(0, 200)
        .map(([key, value]) => [
          maskValue(key, secrets, active, depth + 1),
          maskValue(value, secrets, active, depth + 1),
        ]),
    );
    if (entries.length > 200) masked.$truncated = "additional object entries omitted";
    return masked;
  } finally {
    active.delete(data);
  }
}

export function safeAttribute(value: string, secrets: readonly string[]): string {
  // Mask before bounding so truncation cannot expose a partial credential.
  return sanitizeTraceValue(maskSecrets(value, secrets)) as string;
}

function serialize(value: unknown, metadata: boolean): string | undefined {
  if (value == null || typeof value === "function" || typeof value === "symbol") return undefined;
  try {
    if (!metadata && typeof value === "string") return value;
    return JSON.stringify(
      value,
      metadata
        ? (_, item: unknown) => {
            if (typeof item === "number" && !Number.isFinite(item)) return String(item);
            if (typeof item === "bigint") {
              return item >= BigInt(Number.MIN_SAFE_INTEGER) && item <= BigInt(Number.MAX_SAFE_INTEGER)
                ? Number(item)
                : item.toString();
            }
            return item;
          }
        : undefined,
    );
  } catch {
    return metadata ? JSON.stringify(FAILED) : FAILED;
  }
}

export class OtelObservation implements Observation {
  readonly traceId: string;
  private ended = false;
  // Bound distinct metadata keys across all updates, reserving SDK slots for final fields.
  private readonly metadataKeys = new Set<string>();

  constructor(
    readonly span: Span,
    private readonly secrets: readonly string[],
  ) {
    this.traceId = span.spanContext().traceId;
  }

  get recording(): boolean {
    return !this.ended && this.span.isRecording();
  }

  update(attributes: ObservationAttributes): Observation {
    if (this.ended) return this;
    const raw: [string, unknown][] = [
      ["input", attributes.input],
      ["output", attributes.output],
      ["completion_start_time", attributes.completionStartTime],
      ["model.parameters", attributes.modelParameters],
      ["usage_details", attributes.usageDetails],
      ["cost_details", attributes.costDetails],
    ];
    for (const [key, value] of raw) {
      this.setEncoded(`${OBSERVATION}.${key}`, serialize(value, false), typeof value !== "string");
    }
    this.set(`${OBSERVATION}.level`, attributes.level);
    this.set(`${OBSERVATION}.status_message`, attributes.statusMessage);
    this.set(`${OBSERVATION}.model.name`, attributes.model);
    this.set("langfuse.version", attributes.version);
    this.dimensions(attributes);
    for (const [key, value] of Object.entries(attributes.metadata ?? {})) {
      const name = `${OBSERVATION}.metadata.${safeAttribute(key, this.secrets)}`;
      const encoded = serialize(value, true);
      if (encoded !== undefined && this.reserveMetadata(name)) this.setEncoded(name, encoded, true);
    }
    return this;
  }

  updateTrace(attributes: ObservationAttributes): Observation {
    if (this.ended) return this;
    this.setEncoded(`${TRACE}.input`, serialize(attributes.input, false), typeof attributes.input !== "string");
    this.setEncoded(`${TRACE}.output`, serialize(attributes.output, false), typeof attributes.output !== "string");
    this.set(`${TRACE}.name`, attributes.name);
    this.set("langfuse.version", attributes.version);
    this.dimensions(attributes);
    if (attributes.tags !== undefined) {
      this.span.setAttribute(
        `${TRACE}.tags`,
        attributes.tags.map((tag) => safeAttribute(tag, this.secrets)),
      );
    }
    // The package's trace metadata path uses plain JSON, unlike observation metadata.
    for (const [key, value] of Object.entries(attributes.metadata ?? {})) {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(value);
      } catch {
        serialized = JSON.stringify(FAILED);
      }
      const name = `${TRACE}.metadata.${safeAttribute(key, this.secrets)}`;
      if (serialized !== undefined && this.reserveMetadata(name)) this.setEncoded(name, serialized, true);
    }
    return this;
  }

  end(endTime?: number): Observation {
    if (!this.ended) {
      this.ended = true;
      this.span.end(endTime);
    }
    return this;
  }

  private dimensions(attributes: ObservationAttributes): void {
    this.set("session.id", attributes.sessionId);
    this.set("user.id", attributes.userId);
  }

  private reserveMetadata(key: string): boolean {
    if (this.metadataKeys.has(key)) return true;
    if (this.metadataKeys.size >= 400) return false;
    this.metadataKeys.add(key);
    return true;
  }

  private setEncoded(key: string, value: string | undefined, json: boolean): void {
    if (value === undefined) return;
    if (json && value !== FAILED) {
      // Decode after toJSON/replacer semantics, then redact keys and values before bounding.
      // This preserves valid JSON even when oversized content must be truncated.
      const sanitized = sanitizeTraceValue(maskSecrets(JSON.parse(value), this.secrets));
      this.span.setAttribute(key, JSON.stringify(sanitized));
    } else {
      this.set(key, value);
    }
  }

  private set(key: string, value: string | undefined): void {
    if (value !== undefined) this.span.setAttribute(key, safeAttribute(value, this.secrets));
  }
}
