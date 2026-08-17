# Contributor Guide

## Repository purpose

Larkin is a local Runtime Host that connects supported coding-agent runtimes to Feishu. Keep changes within the current product and repository boundaries.

## Public directory map

- `src/`: product source, grouped by runtime, platform, application, agent, Feishu, setup, and dashboard domains.
- `assets/`: static assets used by the product.
- `scripts/`: build, release, publication, license, and maintenance tooling.
- `test/`: unit, integration, end-to-end, and explicitly opt-in live tests.
- `.github/workflows/`: continuous integration and release workflows.

## Development and validation

Use Bun 1.3.14 and the locked dependency graph:

```bash
bun install --frozen-lockfile
bun run build
bun run test
bun run licenses:check
bun run publication:check:tree
bun run publication:check
```

Keep each change focused. Update the closest tests when behavior changes, and run the smallest relevant test first followed by the full suite before delivery. Do not weaken clean-tree, publication, license, security, or release checks to make a change pass.

### npm distribution surface

The npm package keeps a Bun-first runtime surface, but its install/invocation glue (`scripts/npm/install-binary.mjs` and `scripts/npm/larkin-bin-shim.mjs`) intentionally runs under Node. npm only guarantees Node at install time, and the postinstall binary download plus the `bin` shim must work without Bun so npm users do not need to install it. Node shebangs are therefore allowed only for those two files; `test/integration/build/bun-only-runtime-contract.test.mjs` enforces this single exception.

## Feishu / lark-cli command shape

For any Feishu-related operation, prefer the official `lark-cli` command and flags over a Larkin-invented shortcut. This applies to reads, writes, and other domain commands, not only IM write entries.

- If official CLI already has a command such as `im messages urgent_app`, protect or wrap that exact path. Do not invent a parallel `+messages-...` surface just to make freshness or identity easier.
- Wrapper gates may probe, deny, or inject Runtime-locked identity such as `--as bot`. They must not rename the user-facing command or invent extra required flags that official CLI does not have.
- Keep `+` shortcuts only where official `lark-cli` already defines them, for example `+messages-send` and `+messages-reply`.
- Phone and SMS urgent remain out of scope unless the Owner explicitly authorizes them.

## End-to-end tests

Every requirement should have an end-to-end test that exercises the real command path, not only a classifier or prompt grep. Prefer the smallest test that still proves the change took effect: launcher/integration through `runLarkCli` or the hosted gate first; add an opt-in live test only when the claim depends on Feishu, Windows, npm, or another external system. Fake or API success must not be written as client-visible proof.

## Prompt engineering

When tuning the Larkin standing prompt (`src/agent/context-prompt.ts`), follow the two canonical references and the file header notes:

- OpenAI Prompt Engineering Guide: <https://platform.openai.com/docs/guides/prompt-engineering>
- Anthropic Prompt Engineering overview: <https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview>

Standing rules: prefer structural signals (target/source fields) over model inference; give exact recipe templates plus constraints; keep fail-closed/idempotent/freshness semantics; bump `LARKIN_STANDING_PROMPT_VERSION` on every substantive change and update the affected eval datasets, graders, and assertions; validate behavior changes with the fixed-scenario evals. Do not add new Markdown docs; keep guidance as file-header comments or in this file.

## Repository hygiene

Never commit credentials, tokens, private keys, local configuration, user data, private filesystem paths, or restricted publication inputs. Do not commit generated `dist/`, release `artifacts/`, dependency directories, or local caches. The repository intentionally contains no `docs/` or `.claude/` tree; do not add unapproved Markdown files.

## License and releases

Contributions intentionally submitted for inclusion are licensed under Apache-2.0 as described by the repository `LICENSE` and its contribution terms.

Owner policy: every bugfix or feature delivery must increment the version in `package.json` before merge. Unless the Owner explicitly selects a minor or major increment, default to exactly one patch increment. If the delivery already includes the required increment relative to its base, do not increment it again in a release-only follow-up.

Merging an intentional `package.json` version change to `main` authorizes CI to create the matching immutable tag and GitHub Release. Contributors must not manually create a release tag for an ordinary delivery; the explicit tag-push path is reserved for maintainer recovery. Never move, replace, or overwrite an existing release tag or published GitHub Release.

Published GitHub Releases are mirrored to the npm registry by the `npm-publish` workflow (`.github/workflows/npm-publish.yml`). The release workflow explicitly dispatches it with `workflow_dispatch` (with the release tag) after finalizing the GitHub Release, because `release: published` events raised by `GITHUB_TOKEN` do not create new workflow runs; the `release: published` trigger remains as a fallback for releases finalized outside the release workflow. It publishes the same tagged source as `larkin` on npm using the `NPM_TOKEN` repository secret (an npm automation token). `package.json` must remain publishable: keep `private` unset or `false`, and keep the `files` allowlist in sync with the build and notice artifacts.

Release tags use `vX.Y.Z`, must exactly match the version in `package.json`, and must point to a commit already contained in `main`. Outside the authorized workflow, tag operations are explicit maintainer recovery actions; do not create, move, or replace a release tag as part of an ordinary contribution.
