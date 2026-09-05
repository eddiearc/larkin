<p align="center">
  <img src="./assets/readme/larkin-github-cover.png" width="100%" alt="Larkin connecting Codex, Claude Code, and Pi agent runtimes to Feishu with a local dashboard and message surfaces.">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> · <a href="#requirements">Requirements</a> · <a href="#what-it-does">What it does</a> · <a href="#installation">Installation</a> · <a href="#usage">Usage</a> · <a href="#setup-and-configuration">Setup and configuration</a> · <a href="#details">Details</a> · <a href="#development">Development</a>
</p>

Larkin is a local Runtime Host that connects Codex, Claude Code, and Pi agent runtimes to Feishu (Lark). It keeps sessions, reminders, interactive messages, and a local dashboard close to the machine that runs them.

## Requirements

- A supported macOS, Linux, or Windows (x64) system
- Official `@larksuite/cli >= 1.0.80` (`lark-cli`) (Larkin product policy)
- At least one externally installed agent runtime on `PATH`, already logged in: `pi`, `codex`, or `claude`
- Bun 1.3.14 when running the npm package or building from source (standalone binaries bundle their own runtime)

## Quick start

```bash
npx larkin@latest setup
npx larkin@latest start
npx larkin@latest status
```

## What it does

<table>
<tr>
<td valign="top">

**Runtime host**

Connect supported coding-agent runtimes to Feishu from one local process.

</td>
<td valign="top">

**Persistent workflow**

Keep sessions and reminders available across runs.

</td>
</tr>
<tr>
<td valign="top">

**Message surfaces**

Work with Feishu messages, interactive cards, and related automation.

</td>
<td valign="top">

**Local visibility**

Inspect the host through the embedded dashboard and OpenTelemetry traces.

</td>
</tr>
</table>

The rest of this document uses the short `larkin` form; it works as-is after `npm install -g larkin`, or prefix any command with `npx larkin@latest` to run it without installing.

## Installation

Prefer npm:

```bash
# Run the latest version directly with npx — no install step, always the newest release
npx larkin@latest setup

# Or install globally and use the plain `larkin` command
npm install -g larkin
larkin --version
```

Standalone binaries for macOS, Linux, and Windows (x64) are attached to every [GitHub Release](https://github.com/eddiearc/larkin/releases) for environments without Bun or npm. The Windows 11 x64 core path has passed native end-to-end startup verification. Pull requests and releases also have a blocking native Windows gate that verifies the standalone executable's manifest and SHA-256 before checking its version, help output, and embedded Dashboard over HTTP.

## Usage

Run `larkin --help` or `larkin config --help` for the available commands and configuration options. `larkin agents` reports event readiness, reply-scope readiness, subscription mode/status/dimension, arrivals, and read failures. Local configuration is stored under `~/.larkin` by default; set `LARKIN_CONFIG_DIR` to use another directory.

### Feishu message links

Feishu clients do not reliably render Markdown links such as `[label](URL)` as clickable in text or Markdown messages. When a recipient must be able to open a link, keep the complete bare HTTPS URL visible, for example: Issue 115 — https://github.com/eddiearc/larkin/issues/115. A label may accompany it, but must not replace the bare URL. Larkin does not rewrite exact, verbatim, or user-authored message bodies to enforce this guidance.

## Setup and configuration

Feishu (https://open.feishu.cn) and Lark (https://open.larksuite.com) are different platforms; `larkin setup` must be told which brand with `--tenant feishu|lark` or the interactive prompt before the authorization QR, and must never emit a `feishu.cn` host for a Lark tenant.

During setup, choose one of the three externally installed runtimes: Pi (`pi`), Codex (`codex`), or Claude Code (`claude`). Larkin does not ship a runtime and does not store provider credentials. Install the runtime yourself and complete its own login (`pi` login flow, `codex login`, or `claude login`) before setup. Interactive setup lists each runtime as installed or not installed and refuses a missing binary; non-interactive setup requires `--runtime` and exits non-zero with the same missing-install message.

`larkin setup --model <id>` optionally stores a catalog model for that runtime. After setup, use `larkin model` and `larkin runtime` to inspect or switch. For Pi, Larkin talks to your installed `pi --mode rpc`, verifies the RPC handshake and compaction capability contract, and injects its supported extensions through `pi -e` (background subagents and the 60-second foreground bash timeout guard).

<details>
<summary>Windows support and optional autostart</summary>

Windows 11 x64 core support covers the standalone CLI, local Runtime Host startup, and the embedded Dashboard. The official `lark-cli` and the chosen external Codex, Claude Code, or Pi executable remain separately installed dependencies; secret-bearing live channel/runtime tests are intentionally outside the hosted Windows CI gate.

An Administrator account can optionally start Larkin at that account's interactive logon with Task Scheduler. From an elevated PowerShell prompt, adjust the executable and working-directory paths first:

```powershell
$Exe = 'C:\Tools\Larkin\larkin.exe'
$WorkDir = 'C:\Tools\Larkin'
$Action = New-ScheduledTaskAction -Execute $Exe -Argument 'start' -WorkingDirectory $WorkDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName 'Larkin Runtime Host' -Action $Action -Trigger $Trigger `
  -Description 'Start Larkin for this Administrator account at logon' -RunLevel Highest
```

This is an optional per-user Administrator-logon task, not SYSTEM boot support or a Windows service. Keep the account profile available because Larkin stores its state there. Release executables are currently unsigned; normal Windows security policy and SmartScreen decisions still apply.
</details>

## Details

<details>
<summary>OpenTelemetry traces</summary>

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

`larkin telemetry status` reports bounded queue and endpoint metadata without paths, message text, prompts, model output, commands, credentials, real user IDs, raw errors, headers, or complete URLs. Trace attributes use hashes and low-cardinality enums. `inbox.consume` measures the authoritative direct `larkin inbox poll` operation and inherits the active `agent.turn`. Pi traces add `pi.rpc.submit`, `pi.rpc.lifecycle`, `pi.output.wait`, `pi.generation`, `pi.tool.wait`, and `pi.rpc.settle`, exposing submit-to-accept, observed first-output, tool wait, and settle timing. Document-comment traces expose receive, safe gate, pending/replay, Inbox, Runtime, and an independent `document.comment.reply` client result without recording comment locators or bodies.

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
</details>

## Development

```bash
bun install --frozen-lockfile
bun run build
bun test
```

Use `bun run publication:check:tree` to verify the repository publication boundary and `bun run licenses:check` to verify the runtime-only third-party notice generator.

## License and security

Larkin is licensed under the [Apache License 2.0](./LICENSE). Runtime dependency notices are generated and included with every release. See [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting changes and [SECURITY.md](./SECURITY.md) for private vulnerability reporting.
