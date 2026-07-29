# Contributing to Larkin

Thank you for helping improve Larkin. Search the
[issue tracker](https://github.com/eddiearc/larkin/issues) before starting work
so that related reports and decisions stay in one place.

## When to open an issue first

Open an issue and wait for maintainer alignment before implementing a
non-trivial change. This includes new features, user-visible behavior changes,
architecture or dependency changes, permission or persistence changes, release
changes, and work that touches a security boundary. Describe the problem,
expected behavior, scope, and the smallest useful validation plan. An issue is
alignment on the problem and intended direction, not a guarantee that a
particular implementation will be accepted.

You may open a pull request directly for typo and documentation fixes, narrowly
scoped test improvements, or obvious low-risk bug fixes. Explain the small-change
exemption in the pull request instead of creating a ceremonial issue.

Do not report vulnerabilities or include credentials, private messages, user
data, or exploit details in a public issue. Follow [SECURITY.md](./SECURITY.md)
and use GitHub private vulnerability reporting.

## Development workflow

1. Fork the repository and create a focused branch from the latest `main`.
2. Make one cohesive change and update the closest tests when behavior changes.
3. Run the relevant focused test first, then the repository checks below.
4. Open a pull request, link the aligned issue when one is required, and record
   the commands and actual results used for validation.

Before submitting a change, run:

```bash
bun install --frozen-lockfile
bun run build
bun run test
bun run licenses:check
bun run publication:check:tree
```

Keep pull requests reviewable and avoid unrelated refactors. Do not commit
credentials, local configuration, user data, generated `dist/`, dependency
directories, caches, or release artifacts. Maintainers may close proposals that
conflict with the product boundary or cannot be maintained safely.

By intentionally submitting a contribution for inclusion in Larkin, you agree that it is licensed under the repository's [Apache License 2.0](./LICENSE), as described in section 5 of that license.
