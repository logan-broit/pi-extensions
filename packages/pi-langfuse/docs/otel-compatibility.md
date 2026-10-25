# OpenTelemetry and Langfuse compatibility

Pi Langfuse uses an isolated OpenTelemetry provider, a standard batch processor, and an OTLP HTTP exporter. The supported destination remains Langfuse. The package does not register a global provider, context manager, or propagator, and does not discover other instrumentation.

The public runtime, host-session, and experimental Durable APIs retain their existing contracts. No settings-file or stored-trace migration is required. Stop the owning process before upgrading or changing connection settings; do not replace dependencies while observations are open.

## Langfuse attributes

The adapter retains schema version `2`, the `pi.agent` root, explicit child relationships, and the observation types `agent`, `span`, `generation`, and `tool`. A root starts independently of an unrelated active application span. Owned roots receive the boolean `langfuse.internal.is_app_root` marker. A child of an already-ended owned parent retains that parent's trace relationship but starts a new app-root segment, matching the previous processor's behavior.

The following keys describe the package's compatibility contract, not a general-purpose Langfuse SDK replacement:

| Value | OTLP span attribute | Encoding |
| --- | --- | --- |
| Observation type | `langfuse.observation.type` | String |
| Observation input/output | `langfuse.observation.input`, `langfuse.observation.output` | Raw string or JSON string |
| Observation metadata | `langfuse.observation.metadata.<key>` | One JSON-encoded value per top-level key |
| Level | `langfuse.observation.level` | `DEBUG`, `DEFAULT`, `WARNING`, or `ERROR` |
| Status message | `langfuse.observation.status_message` | String |
| Completion start | `langfuse.observation.completion_start_time` | JSON-encoded `Date` |
| Model | `langfuse.observation.model.name` | String |
| Model parameters | `langfuse.observation.model.parameters` | JSON object string |
| Usage/cost details | `langfuse.observation.usage_details`, `langfuse.observation.cost_details` | JSON object string |
| Version | `langfuse.version` | String |
| Trace name | `langfuse.trace.name` | String; does not rename the observation |
| Trace input/output | `langfuse.trace.input`, `langfuse.trace.output` | Raw string or JSON string |
| Trace metadata | `langfuse.trace.metadata.<key>` | One JSON-encoded value per top-level key |
| Session/user | `session.id`, `user.id` | String |
| Trace tags | `langfuse.trace.tags` | String array |
| Environment/release | `langfuse.environment`, `langfuse.release` | String |

`updateTrace()` writes trace attributes on the receiving span. It does not replace that span's observation input/output or mutate sibling spans. Trace-only updates do not automatically copy dimensions to every descendant. The recorders set the dimensions needed for their own projections.

Langfuse documents trace input/output as deprecated legacy fields. The adapter retains them for compatibility and records the overall request/response on the root observation as well. Langfuse v4 uses observation input/output for its observations-first model.

Input/output strings remain unquoted, including empty strings. Null and undefined values are omitted without clearing an earlier value. Other values use JSON serialization: `false` and zero remain present, dates become quoted ISO strings, and non-finite numbers become `null`. Values omitted by JSON remain omitted; serialization failures use `<failed to serialize>`. Metadata is encoded separately, so a metadata string is JSON-quoted and nested objects are not flattened recursively. Credential masking and content redaction must not remove these field-specific encoding differences.

Observation metadata omits top-level null, undefined, functions, and symbols; non-finite numbers become strings, safe integers represented as bigint become numbers, and larger bigint values become decimal strings. Failed observation-metadata serialization uses a JSON-quoted failure marker. Trace metadata uses plain JSON encoding instead: null and non-finite numbers become `null`. Metadata serialization failures use a JSON-quoted failure marker rather than exposing raw exception text.

`startTime` uses a JavaScript `Date`; numeric `endTime` uses OpenTelemetry's epoch-millisecond input convention. Langfuse severity is an explicit attribute: warnings and ordinary outcomes must not become OpenTelemetry errors merely because they are not successful outcomes.

## Transport and environment

The exporter sends OTLP HTTP/JSON to `<baseUrl>/api/public/otel/v1/traces`, including any validated base path. The base URL must use HTTP or HTTPS without embedded credentials, query parameters, or fragments. Prefer HTTPS.

Authentication is `Authorization: Basic base64(publicKey:secretKey)` in the request header only. The exporter sends `x-langfuse-ingestion-version: 4`. SDK attribution, if present, identifies Pi Langfuse rather than a removed Langfuse SDK.

The default batch size is 512 spans, with a five-second schedule and five-second request timeout. Batching and retries use the OpenTelemetry implementation. Queues are bounded and are not a disk-backed delivery log. A process crash, queue overflow, oversized export, or exhausted transport retries can lose observations.

Host connection fields resolve independently from explicit `config`, then the supplied `env` object or `process.env`, then defaults. The connection names are listed in the [README](../README.md#-host-application-embedding).

For embedded hosts with environment access enabled, compression resolves from `LANGFUSE_OTEL_COMPRESSION`, `OTEL_EXPORTER_OTLP_TRACES_COMPRESSION`, then `OTEL_EXPORTER_OTLP_COMPRESSION`, with gzip as the default. Accepted values are `gzip` and `none`; invalid values fall through to the next source. `LANGFUSE_OTEL_MAX_BATCH_SIZE_BYTES` accepts a positive safe integer for the export-size guard; missing or invalid values use 64 MiB. This guard is a conservative lower-bound check, not an exact compressed HTTP body limit.

For public embedded runtime creation, `env: false` disables these environment controls as well as environment credentials. The default extension resolves connection fields only from validated JSON, while retaining its existing compression and export-size environment controls. Set `LANGFUSE_OTEL_COMPRESSION=none` before starting Pi when a proxy cannot accept gzip; missing controls retain gzip and the default size guard.

Generic `OTEL_EXPORTER_OTLP_*` destination, authentication, header, and timeout overrides are not supported connection settings. They must not redirect this package's export or replace its credentials. Langfuse SDK logging, media, and propagation variables do not enable SDK features in this adapter.

## Privacy and delivery limits

The recorders retain bounded capture, metadata-only mode, signature removal, and data-URI redaction. The production adapter masks configured Langfuse credentials before writing attributes. Masking traversals are bounded before content sanitization, and JSON attributes remain valid after truncation. Each observation accepts at most 400 distinct observation/trace metadata attribute keys across updates; existing keys can still be updated after that limit. Extra keys are omitted to reserve SDK slots for final output, status, and other required fields. Media is not uploaded. These protections are not a general secret scanner; see [Security and privacy](../README.md#-security-and-privacy) before exporting content or correlation data.

The package does not configure process-global OpenTelemetry diagnostics. A host that enables third-party transport diagnostics controls that output and must review its handling of endpoint and server-provided error text; do not assume raw transport debug logs are safe for sensitive data.

Flush waits for the SDK's flush operation, not a service storage acknowledgement. Shutdown closes owned controllers before flushing and stopping the provider. Dispose each host controller before the host shuts down the shared runtime. Tracing does not provide exactly-once delivery, durable replay, or crash recovery.

Langfuse prompt management, scores, media upload, SDK baggage propagation, arbitrary GenAI instrumentation export, and third-party instrumentation discovery are outside this adapter's scope. Their exclusion does not remove an API previously exposed by Pi Langfuse.

## Verification and rollout

Deterministic local collector tests can verify endpoint selection, headers, serialization, redaction, parent IDs, and exporter behavior. They do not prove that a particular Langfuse deployment accepts or displays those values correctly. Automated Pi resource-loader tests cover registration, lazy activation, and lifecycle behavior without opening a TUI. They do not establish visual acceptance of interactive startup or manual `/reload`; an operator must check those paths when they are required for deployment.

From the repository root, verify an actual packed artifact with:

```bash
node packages/pi-langfuse/scripts/smoke-packed.mjs /absolute/path/to/pi-langfuse.tgz
```

The standalone smoke copies the root `.npmrc` unchanged and installs the tarball in a fresh temporary consumer with scripts, development dependencies, and automatic peer installation omitted. It installs the packed manifest's exact tested coding-agent host version. Native Node ESM imports the root without Durable or Chord peers and exports synthetic Pi lifecycle traces to a loopback OTLP JSON/gzip collector. It checks hierarchy, app-root metadata, redaction, content-disabled capture, flush, and shutdown. It then installs the packed manifest's exact tested Durable and Chord host versions, imports `/durable`, and checks public declarations with the repository compiler. An optional second argument supplies an absolute `tsc.js` path. No repository dependency links or import hooks are used; temporary files and owned processes are removed on completion or failure. Registry access and a built tarball are required; this smoke runs outside Vitest.

Before production rollout, use synthetic non-sensitive data on an authorized Langfuse deployment and confirm hierarchy, root selection, input/output, usage/cost, session linkage, environment/release, and redaction. Langfuse ingestion and UI compatibility remain unverified without that service check. Keep release blocked if service acceptance is a release requirement. Do not supply production secrets in test fixtures or chat.

## References

- [Langfuse OTLP endpoint and authentication](https://langfuse.com/integrations/native/opentelemetry#opentelemetry-endpoint), including HTTP/JSON and HTTP/protobuf support.
- [Langfuse property mapping](https://langfuse.com/integrations/native/opentelemetry#property-mapping), including JSON encoding, explicit metadata, severity, and `session.id`/`user.id` aliases.
- [Langfuse v4 ingestion migration](https://langfuse.com/integrations/native/opentelemetry/migration-to-v4), including the ingestion-version header and root observation input/output.
- [Pinned official mapping source](https://github.com/langfuse/langfuse-docs/blob/993ce3cdbee7775b56fef00bcc8c02be60412137/content/integrations/native/opentelemetry/index.mdx) for reviewable schema evidence.
- [Pinned service attribute keys](https://github.com/langfuse/langfuse/blob/f6c3660ced73d380f1936d2adb0cca97f16e4d2a/packages/shared/src/server/otel/attributes.ts#L39) and [app-root interpretation](https://github.com/langfuse/langfuse/blob/f6c3660ced73d380f1936d2adb0cca97f16e4d2a/packages/shared/src/server/otel/OtelIngestionProcessor.ts#L1220): the app-root marker is an internal service compatibility key, not a documented public OTLP property.

These references define wire expectations; they are not evidence of a completed live-service smoke.
