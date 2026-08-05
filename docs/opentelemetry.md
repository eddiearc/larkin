# OpenTelemetry traces

Larkin can record a privacy-safe timing waterfall for each woken Feishu message. Tracing is opt-in. When enabled, ended spans first enter a durable local OTLP/HTTP JSON spool; message processing does not depend on an observability backend being reachable.

## Enable local recording

Set these variables in the environment that starts Larkin:

```bash
export LARKIN_TELEMETRY_ENABLED=1
# Optional. Without this setting traces only remain in the local spool.
export LARKIN_TELEMETRY_OTLP_ENDPOINT=https://collector.example/v1/traces
# Optional comma-separated name=value fields. They are never persisted or printed.
export LARKIN_TELEMETRY_OTLP_HEADERS='Authorization=Bearer%20REDACTED'
larkin start
```

The default spool is under `$LARKIN_HOME/telemetry/spool`, with a `0700` directory and `0600` files. Defaults are 64 MiB, 10,000 files, and 14 days. Override them with `LARKIN_TELEMETRY_MAX_BYTES`, `LARKIN_TELEMETRY_MAX_FILES`, and `LARKIN_TELEMETRY_MAX_AGE_MS`. Oldest/expired data is dropped first, and malformed records are quarantined so later valid records can proceed. Network errors, timeouts, 429, 5xx, non-200 2xx, malformed responses, and responses over 64 KiB leave files queued. A normal upload is acknowledged only on HTTP 200. Per OTLP/HTTP 1.11, a populated `partialSuccess` response is recorded in the safe dropped-span diagnostics and acknowledged without retry, preventing duplicate delivery. Automatic uploading is disabled unless an endpoint is configured.

`larkin telemetry status` reports only queue counts/bytes, oldest age, drop count, the last error category, and endpoint scheme/host. It never prints headers, URL paths/userinfo/query, filesystem paths, message text, prompts, model output, commands, credentials, real user IDs, or raw errors. Trace attributes use hashes and low-cardinality enums. `model.activity` and `tool.execute` measure consecutive activity intervals observed by Larkin's Runtime Host; they are not provider queue, first-token, or provider-internal tool timing.

## Move traces offline

On the remote computer:

```bash
larkin telemetry status
larkin telemetry export --output larkin-traces.json.gz
```

Export has copy semantics: it does not delete the source queue. Move the gzip bundle to the computer that can reach the collector, then run:

```bash
larkin telemetry import --input larkin-traces.json.gz
larkin telemetry flush --endpoint http://127.0.0.1:4318/v1/traces
```

Bundles contain versioned OTLP payloads plus SHA-256 checksums. Import validates size, schema, and checksums, assigns local queue identities, and is idempotent. Original trace/span IDs, parentage, status, and timestamps are not rewritten.

Ended spans survive process restarts. A clean shutdown also closes active spans and removes the cross-process parent context. Ownership is renewed while the runtime stays alive, activity refreshes the active turn context, and both PID and operating-system process-start identity are checked to reject PID reuse. An operating-system kill that gives the process no shutdown opportunity can lose the currently open intervals, but stale parent context is rejected on the next startup and previously ended spans remain queued.

## View with Grafana OTEL-LGTM

The repository includes a development-only reference stack pinned to `grafana/otel-lgtm:0.27.1`:

```bash
docker compose -f deploy/otel-lgtm/compose.yaml up -d
larkin telemetry flush --endpoint http://127.0.0.1:4318/v1/traces
# Or run the content-free, end-to-end Collector + Tempo semantic check:
bun run test:telemetry:lgtm
```

Open <http://127.0.0.1:3000>, sign in with the image's development default (`admin` / `admin`), then use **Explore → Tempo** and search `service.name = larkin` or paste a trace ID. A complete trace contains:

```text
larkin.message.process
├── feishu.receive
├── runtime.deliver
└── agent.turn
    ├── model.activity
    ├── tool.execute
    ├── inbox.consume
    └── feishu.send
```

For a direct backend check, copy the trace ID from an exported OTLP payload or Grafana and query:

```bash
curl -fsS "http://127.0.0.1:3200/api/traces/TRACE_ID"
```

The compose file binds Grafana, Tempo, and OTLP only to `127.0.0.1` and persists `/data`. OTEL-LGTM is intended for development, demos, and testing. Do not expose its default credentials or plaintext port 4318 to the public internet. For remote automatic upload, provide a deployment-owned TLS/authenticated endpoint or a private network such as Tailscale; Larkin intentionally does not provision that infrastructure.

To update the pinned image, review the upstream release notes, change the tag in `deploy/otel-lgtm/compose.yaml`, pull it, then repeat the real upload and Tempo query acceptance check.
