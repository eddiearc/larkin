# Contributing to Larkin

Keep changes focused and update the closest tests when behavior changes. Before submitting a change, run:

```bash
bun install --frozen-lockfile
bun run build
bun test
bun run licenses:check
bun run publication:check:tree
```

Do not commit credentials, local configuration, user data, generated `dist/`, or release artifacts. Report security vulnerabilities according to [SECURITY.md](./SECURITY.md), not through the public issue tracker.

By intentionally submitting a contribution for inclusion in Larkin, you agree that it is licensed under the repository's [Apache License 2.0](./LICENSE), as described in section 5 of that license.
