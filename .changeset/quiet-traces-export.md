---
"@narumitw/pi-langfuse": patch
---

Replace the Langfuse SDK with standard OpenTelemetry tracing and OTLP HTTP export to Langfuse while retaining the public runtime, host-session, and experimental Durable APIs and schema-v2 trace hierarchy.

The tracing runtime requires Node.js >=22.15.0; supported Pi hosts require >=22.19.0. Preserve credential masking and bounded content capture. Document transport environment controls, delivery limits, and the need to validate ingestion against the target Langfuse deployment. Explicit embedded-runtime `env: false` disables transport environment access. The default extension retains its documented compression and export-size environment controls while resolving connection fields only from validated settings.
