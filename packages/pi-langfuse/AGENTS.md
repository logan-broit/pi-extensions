# Pi Langfuse Guidelines

- Redact embedded base64 data URIs anywhere in stringified trace content before observations end because Langfuse's media scanner can reject data-URI-like substrings.
- Keep `@opentelemetry/exporter-trace-otlp-http` as a direct runtime dependency so independently installed packages can export traces without relying on a transitive dependency.
