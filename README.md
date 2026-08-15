# Larkin

Larkin connects Codex, Claude Code, and Pi agent runtimes to Feishu (Lark). It provides a local runtime host, persistent sessions, reminders, interactive messages, and a local dashboard.

## Requirements

- A supported macOS, Linux, or Windows (x64) system
- `lark-cli`
- At least one supported agent runtime and its authentication
- Bun 1.3.14 when running the npm package or building from source (standalone binaries bundle their own runtime)

## Installation

Larkin is published to the npm registry and also distributed as standalone binaries. Prefer npm:

```bash
# Run the latest version directly with npx — no install step, always the newest release
npx larkin@latest setup

# Or install globally and use the plain `larkin` command
npm install -g larkin
larkin --version
```

Standalone binaries for macOS, Linux, and Windows (x64) are attached to every [GitHub Release](https://github.com/eddiearc/larkin/releases) for environments without Bun or npm. The Windows 11 x64 core path has passed native end-to-end startup verification. Pull requests and releases also have a blocking native Windows gate that verifies the standalone executable's manifest and SHA-256 before checking its version, help output, and embedded Dashboard over HTTP.

## Usage

```bash
npx larkin@latest setup
npx larkin@latest start
npx larkin@latest status
```

The rest of this document uses the short `larkin` form; it works as-is after `npm install -g larkin`, or prefix any command with `npx larkin@latest` to run it without installing.

Run `larkin --help` or `larkin config --help` for the available commands and configuration options. Local configuration is stored under `~/.larkin` by default; set `LARKIN_CONFIG_DIR` to use another directory.

### Feishu message links

Feishu clients do not reliably render Markdown links such as `[label](URL)` as clickable in text or Markdown messages. When a recipient must be able to open a link, keep the complete bare HTTPS URL visible, for example: Issue 115 — https://github.com/eddiearc/larkin/issues/115. A label may accompany it, but must not replace the bare URL. Larkin does not rewrite exact, verbatim, or user-authored message bodies to enforce this guidance.

During setup, a new Agent is offered Pi first, followed by Codex and Claude Code. Pi can use an existing
official `pi` installation or the official Pi runtime bundled in Larkin. The bundled option supports
DeepSeek, Kimi/Moonshot, MiniMax, Zhipu/BigModel, and a custom OpenAI-compatible Base URL. Provider keys
are stored only in the selected Agent's private provider directory, not in the ordinary Agent config. Setup
also discovers every API-key and OAuth/subscription login exposed by the pinned official Pi registry and
delegates those flows to Pi. Use `larkin pi-auth status` or `larkin pi-auth logout <provider>` to manage them.
The builtin Pi runtime loads Larkin's two supported extensions inline: background subagents and the 60-second
foreground bash timeout guard are enabled without writing extension files or arguments. A compatible external
Pi installation keeps the existing explicit `-e` extension path.

### Windows support boundary and optional autostart

Windows 11 x64 core support covers the standalone CLI, local Runtime Host startup, builtin Pi RPC with the
inline extensions above, and the embedded Dashboard. Provider authentication, the official `lark-cli`, and
external Codex, Claude Code, or Pi executables remain separately installed dependencies; secret-bearing live
channel/provider tests are intentionally outside the hosted Windows CI gate.

An Administrator account can optionally start Larkin at that account's interactive logon with Task Scheduler.
From an elevated PowerShell prompt, adjust the executable and working-directory paths first:

```powershell
$Exe = 'C:\Tools\Larkin\larkin.exe'
$WorkDir = 'C:\Tools\Larkin'
$Action = New-ScheduledTaskAction -Execute $Exe -Argument 'start' -WorkingDirectory $WorkDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName 'Larkin Runtime Host' -Action $Action -Trigger $Trigger `
  -Description 'Start Larkin for this Administrator account at logon' -RunLevel Highest
```

This is an optional per-user Administrator-logon task, not SYSTEM boot support or a Windows service. Keep the
account profile available because Larkin stores its state there. Release executables are currently unsigned;
normal Windows security policy and SmartScreen decisions still apply.

For supported Feishu cloud-document comments (`doc`, `docx`, `sheet`, and `file`), the safe default accepts only comments or replies that @ the Bot. Document comments never reuse IM `require`/`free` settings. An explicit platform-verified application-dimension Bot subscription accepts every supported comment event that Feishu actually delivers, whether or not it mentions the Bot. Larkin stores accepted comments as `kind=document_comment` canonical Inbox events and wakes the Bot's persistent Agent. Replies are bound back to the exact comment; whole-document comments use Feishu's top-level fallback. `larkin setup --comment-subscription application` makes the broad trigger surface explicit, creates the Bot subscription through the official `lark-cli` structured API, and then verifies it with the read-only platform status API. `--comment-subscription none` explicitly removes that application subscription and verifies removal. Until positive status verification, only @Bot comments enter the Inbox. Setup requests `docs:document.comment:create` for both in-thread replies and whole-document `create_v2` fallback, while retaining `drive:drive` for event/read support. `larkin agents` reports event readiness, reply-scope readiness, subscription mode/status/dimension, arrivals, and read failures.

## OpenTelemetry traces

Larkin records a privacy-safe timing waterfall for each woken Feishu message. Tracing is always enabled, and ended spans first enter a durable local OTLP/HTTP JSON spool. Message processing therefore does not depend on an observability backend being reachable.

Local recording needs no enable flag. Configure an endpoint only when this computer should upload automatically:

```bash
# Optional: without an endpoint, traces remain only in the local spool.
export LARKIN_TELEMETRY_OTLP_ENDPOINT=https://collector.example/v1/traces
# Optional comma-separated name=value fields; never persisted or printed.
export LARKIN_TELEMETRY_OTLP_HEADERS='Authorization=Bearer%20REDACTED'
larkin start
```

The default spool is `$LARKIN_HOME/telemetry/spool`. Its directory and files use modes `0700` and `0600`. Defaults are 64 MiB, 10,000 files, and 14 days; override them with `LARKIN_TELEMETRY_MAX_BYTES`, `LARKIN_TELEMETRY_MAX_FILES`, and `LARKIN_TELEMETRY_MAX_AGE_MS`. Network errors and rejected uploads remain queued. A successful HTTP 200 acknowledges the local batch; an OTLP `partialSuccess` with rejected spans is recorded as a safe drop and is not retried.

`larkin telemetry status` reports bounded queue and endpoint metadata without paths, message text, prompts, model output, commands, credentials, real user IDs, raw errors, headers, or complete URLs. Trace attributes use hashes and low-cardinality enums. `inbox.consume` measures the authoritative direct `larkin inbox poll` operation and inherits the active `agent.turn`. Bundled Pi traces add `pi.rpc.submit`, `pi.rpc.lifecycle`, `pi.output.wait`, `pi.generation`, `pi.tool.wait`, and `pi.rpc.settle`, exposing submit-to-accept, observed first-output, tool wait, and settle timing. External Pi is labeled as external and does not claim these bundled-process intervals. Document-comment traces expose receive, safe gate, pending/replay, Inbox, Runtime, and an independent `document.comment.reply` client result without recording comment locators or bodies.

### Offline transfer

On the computer running Larkin:

```bash
larkin telemetry status
larkin telemetry export --output larkin-traces.json.gz
```

Export uses copy semantics and does not delete the source queue. Move the bundle to a computer that can reach the collector, then run:

```bash
larkin telemetry import --input larkin-traces.json.gz
larkin telemetry flush --endpoint http://127.0.0.1:4318/v1/traces
```

Bundles contain versioned OTLP payloads and SHA-256 checksums. Import validates the complete bundle before mutation, assigns local queue identities, and is idempotent. Trace IDs, parentage, status, and timestamps are preserved across export and import.

### Grafana OTEL-LGTM

The repository includes a development-only stack pinned to `grafana/otel-lgtm:0.27.1`:

```bash
docker compose -f deploy/otel-lgtm/compose.yaml up -d
larkin telemetry flush --endpoint http://127.0.0.1:4318/v1/traces
# Content-free Collector + Tempo semantic acceptance check:
bun run test:telemetry:lgtm
```

Open <http://127.0.0.1:3000>, sign in with the image's development default (`admin` / `admin`), then use **Explore → Tempo** and search for `service.name = larkin` or paste a trace ID. A complete trace contains:

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

The compose stack binds Grafana, Tempo, and OTLP only to `127.0.0.1` and persists `/data`. It is intended for development, demos, and testing. Do not expose its default credentials or plaintext OTLP port publicly; use a deployment-owned TLS/authenticated endpoint or private network for remote automatic upload.

## Development

```bash
bun install --frozen-lockfile
bun run build
bun test
```

Use `bun run publication:check:tree` to verify the repository publication boundary and `bun run licenses:check` to verify the runtime-only third-party notice generator.

## License and security

Larkin is licensed under the [Apache License 2.0](./LICENSE). Runtime dependency notices are generated and included with every release. See [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting changes and [SECURITY.md](./SECURITY.md) for private vulnerability reporting.
