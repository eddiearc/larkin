# Larkin OpenTelemetry observability validation

- Source base: `52e750907cedcc0550e323985fc8b4bfb28735d4`
- Validated implementation: `codex/otel-observability` evaluator fix pass
- Environment: Darwin arm64, Bun 1.3.14, Docker 28.0.4
- Validation date: 2026-08-05 (Asia/Shanghai)

## Outside-in trace and privacy contract

Command:

```bash
bun test --max-concurrency 1 \
  test/unit/telemetry/telemetry.test.mjs \
  test/unit/agent/transport-business-context.test.mjs \
  test/integration/app/telemetry-cli.test.mjs \
  test/e2e/runtime-production-mock-e2e.test.mjs
```

Result: PASS. The fixed scenario creates the standard OTLP tree `larkin.message.process`, `feishu.receive`, `runtime.deliver`, `agent.turn`, `model.activity`, `tool.execute`, `inbox.consume`, and `feishu.send`. It verifies exact OTLP kinds and parent IDs, non-zero activity durations, busy fan-in links, `0700`/`0600` permissions, bounded retention, queue single ownership, symlink-swap rejection, 429/5xx/partial-success retention, whole-bundle validation before mutation, checksum/idempotency, and forbidden sentinel absence. The production Mock E2E covers HostShell → canonical Inbox → RuntimeHost model/tool activity; the production transport test executes the actual send path and verifies the cross-process `feishu.send` parent. The CLI integration runs the real internal dispatcher through `status`, `export`, `import`, and `flush`, including output redaction.

## Repository and standalone gates

```bash
bun run test
LARKIN_RUN_STANDALONE_RELEASE_TEST=1 bun test --max-concurrency 1 \
  test/integration/build/standalone-release.test.mjs
git diff --check
gitleaks detect --source . --no-banner --redact --no-git
```

Result: PASS. The default gate completed typecheck, build, frontend, unit, integration, and Mock E2E suites with zero failures (documented opt-in/live checks remained skipped). Native standalone build/install/rollback passed. `git diff --check` passed and Gitleaks reported no leaks.

## Real OTEL-LGTM Collector and Tempo

Backend:

```text
image=grafana/otel-lgtm:0.27.1
status=running
OTLP/HTTP=http://127.0.0.1:4318/v1/traces
Tempo=http://127.0.0.1:3200
```

A committed content-free fixture writes a trace to the durable spool, uploads it to the real Collector, queries Tempo, and rejects incorrect kinds, parents, timestamps, counts, or queue acknowledgement:

```bash
bun run test:telemetry:lgtm
```

Query summary:

```json
{
  "traceId": "5be31e2dc909846158e1aee7c1c813a3",
  "spanCount": 8,
  "kinds": {
    "larkin.message.process": "SPAN_KIND_CONSUMER",
    "feishu.receive": "SPAN_KIND_CONSUMER",
    "runtime.deliver": "SPAN_KIND_PRODUCER",
    "agent.turn": "SPAN_KIND_INTERNAL",
    "model.activity": "SPAN_KIND_INTERNAL",
    "tool.execute": "SPAN_KIND_INTERNAL",
    "inbox.consume": "SPAN_KIND_CONSUMER",
    "feishu.send": "SPAN_KIND_CLIENT"
  },
  "parentage": "validated",
  "queueAfterUpload": 0
}
```

The same result reported positive durations for all eight spans (including roughly 11.8 ms model and 12.7 ms tool fixture intervals). This is local Real API E2E evidence against the development/test LGTM stack. It does not prove a production public-network deployment, TLS/auth configuration, long-term retention, provider-internal first-token/queue timing, or preservation of an interval that is still open during an ungraceful kill. Those remain deployment-owned, bounded limitations, or intentionally outside scope.
