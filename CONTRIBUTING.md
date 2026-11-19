# Contributing

Setup and the playground are in the README's
[Development](README.md#development) section.

CI runs:

```sh
pnpm check-upstream
pnpm build
pnpm typecheck
pnpm test            # unit tests (vitest)
pnpm test:types
pnpm test:e2e        # Playwright, Chromium and Firefox
```

Install the e2e browsers first:
`pnpm --filter playground exec playwright install --with-deps chromium firefox`.

A user-facing change needs a changeset: `pnpm changeset`. See
`.changeset/README.md`.

Vendored upstream code is checked with `pnpm check-upstream`. Pins live in
`upstream.json`, and each vendored directory has an `UPSTREAM.md`. To pull a
new commit, see [Upstream code](README.md#upstream-code).
