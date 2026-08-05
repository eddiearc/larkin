# Larkin

Larkin connects Codex, Claude Code, and Pi agent runtimes to Feishu. It provides a local runtime host, persistent sessions, reminders, interactive messages, and a local dashboard.

## Requirements

- A supported macOS or Linux system
- `lark-cli`
- At least one supported agent runtime and its authentication
- Bun 1.3.14 when building from source

## Usage

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

For supported Feishu cloud-document comments (`doc`, `docx`, `sheet`, and `file`), explicitly @ the Bot in a comment or reply. Larkin receives `drive.notice.comment_add_v1` on the existing event connection, stores the fetched comment as a `kind=document_comment` canonical Inbox event, and wakes the Bot's persistent Agent. The Agent's reply is bound back to that exact comment; whole-document comments use Feishu's top-level fallback. Re-run `larkin setup` for an existing Bot to request the required event and `drive:drive` tenant scope, publish the updated app configuration, and ensure the Bot can access the document. `larkin agents` distinguishes requested-but-unverified configuration, a real event arrival, and comment-read failures.

## Development

```bash
bun install --frozen-lockfile
bun run build
bun test
```

Use `bun run publication:check:tree` to verify the repository publication boundary and `bun run licenses:check` to verify the runtime-only third-party notice generator.

## License and security

Larkin is licensed under the [Apache License 2.0](./LICENSE). Runtime dependency notices are generated and included with every release. See [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting changes and [SECURITY.md](./SECURITY.md) for private vulnerability reporting.
