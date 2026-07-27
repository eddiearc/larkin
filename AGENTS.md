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

## Repository hygiene

Never commit credentials, tokens, private keys, local configuration, user data, private filesystem paths, or restricted publication inputs. Do not commit generated `dist/`, release `artifacts/`, dependency directories, or local caches. The repository intentionally contains no `docs/` or `.claude/` tree; do not add unapproved Markdown files.

## License and releases

Contributions intentionally submitted for inclusion are licensed under Apache-2.0 as described by the repository `LICENSE` and its contribution terms.

Release tags use `vX.Y.Z`, must exactly match the version in `package.json`, and must point to a commit already contained in `main`. Version changes and release tags are explicit maintainer actions; do not create, move, or replace a release tag as part of an ordinary contribution.
