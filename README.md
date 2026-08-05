# Larkin

Larkin connects Codex, Claude Code, and Pi agent runtimes to Feishu. It provides a local runtime host, persistent sessions, reminders, interactive messages, and a local dashboard.

## Requirements

- A supported macOS or Linux system
- `lark-cli`
- At least one supported agent runtime and its authentication
- Bun 1.3.14 when building from source

## Usage

OpenTelemetry 耗时瀑布、本地耐久队列、离线搬运与 Grafana OTEL-LGTM 展示见
[docs/opentelemetry.md](./docs/opentelemetry.md)。

```bash
larkin setup
larkin start
larkin status
```

Run `larkin --help` or `larkin config --help` for the available commands and configuration options. Local configuration is stored under `~/.larkin` by default; set `LARKIN_CONFIG_DIR` to use another directory.

During setup, a new Agent is offered Pi first, followed by Codex and Claude Code. Pi can use an existing
official `pi` installation or the official Pi runtime bundled in Larkin. The bundled option supports
DeepSeek, Kimi/Moonshot, MiniMax, Zhipu/BigModel, and a custom OpenAI-compatible Base URL. Provider keys
are stored only in the selected Agent's private provider directory, not in the ordinary Agent config. Setup
also discovers every API-key and OAuth/subscription login exposed by the pinned official Pi registry and
delegates those flows to Pi. Use `larkin pi-auth status` or `larkin pi-auth logout <provider>` to manage them.

For supported Feishu cloud-document comments (`doc`, `docx`, `sheet`, and `file`), the safe default accepts only comments or replies that @ the Bot. Document comments never reuse IM `require`/`free` settings. An explicit platform-verified application-dimension Bot subscription accepts every supported comment event that Feishu actually delivers, whether or not it mentions the Bot. Larkin stores accepted comments as `kind=document_comment` canonical Inbox events and wakes the Bot's persistent Agent. Replies are bound back to the exact comment; whole-document comments use Feishu's top-level fallback. `larkin setup --comment-subscription application` makes the broad trigger surface explicit, creates the Bot subscription through the official `lark-cli` structured API, and then verifies it with the read-only platform status API. `--comment-subscription none` explicitly removes that application subscription and verifies removal. Until positive status verification, only @Bot comments enter the Inbox. Setup requests `docs:document.comment:create` for both in-thread replies and whole-document `create_v2` fallback, while retaining `drive:drive` for event/read support. `larkin agents` reports event readiness, reply-scope readiness, subscription mode/status/dimension, arrivals, and read failures.

## Development

```bash
bun install --frozen-lockfile
bun run build
bun test
```

Use `bun run publication:check:tree` to verify the repository publication boundary and `bun run licenses:check` to verify the runtime-only third-party notice generator.

## License and security

Larkin is licensed under the [Apache License 2.0](./LICENSE). Runtime dependency notices are generated and included with every release. See [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting changes and [SECURITY.md](./SECURITY.md) for private vulnerability reporting.
