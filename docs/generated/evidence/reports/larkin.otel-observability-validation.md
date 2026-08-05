# Larkin OpenTelemetry observability validation

- Source base: `52e750907cedcc0550e323985fc8b4bfb28735d4`
- Environment: Darwin arm64, Bun 1.3.14, Docker 28.0.4
- Validation date: 2026-08-05 (Asia/Shanghai)

## Outside-in trace and privacy contract

Command:

```bash
bun test --max-concurrency 1 \
  test/unit/telemetry/telemetry.test.mjs \
  test/integration/app/telemetry-cli.test.mjs \
  test/e2e/runtime-production-mock-e2e.test.mjs
```

Result: PASS. The fixed scenario creates the standard OTLP tree `larkin.message.process`, `feishu.receive`, `runtime.deliver`, `agent.turn`, `model.activity`, `tool.execute`, `inbox.consume`, and `feishu.send`. It verifies parentage, busy fan-in links, status/timestamps, `0700`/`0600` permissions, bounded retention, atomic queue records, network failure retention, success-only acknowledgement, bundle checksum/idempotency, and forbidden sentinel absence. The production Mock E2E covers HostShell → canonical Inbox → RuntimeHost wiring; the CLI integration runs the real internal dispatcher through `status`, `export`, `import`, and `flush`.

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

A synthetic, content-free fixed trace was written to the durable spool and uploaded through the real telemetry CLI. `flush` reported `uploadedFiles=8`, `status=uploaded`, and an empty queue. Tempo was then queried rather than accepting the Collector response as sufficient evidence:

```bash
curl -fsS http://127.0.0.1:3200/api/traces/1b3df78583ad8cf6a779834979fdb452
```

Query summary:

```json
{
  "traceId": "1b3df78583ad8cf6a779834979fdb452",
  "spanCount": 8,
  "names": [
    "agent.turn",
    "feishu.receive",
    "feishu.send",
    "inbox.consume",
    "larkin.message.process",
    "model.activity",
    "runtime.deliver",
    "tool.execute"
  ]
}
```

This is local Real API E2E evidence against the development/test LGTM stack. It does not prove a production public-network deployment, TLS/auth configuration, long-term retention, or provider-internal first-token/queue timing. Those remain deployment-owned or intentionally outside scope.
