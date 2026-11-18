# Changesets

This folder is managed by [`@changesets/cli`](https://github.com/changesets/changesets).
Run `pnpm changeset` in a PR that changes `preact-devtools-overlay` and pick a
bump (`patch` / `minor` / `major`). On `main`, the Release workflow collects
pending changesets into a "Version Packages" PR. Merging that PR publishes to
npm.

## Repo policy

Write the entry for someone scanning a release, not someone reviewing the PR.

- Normally use one direct sentence that states the user-visible outcome.
- Add a second sentence only when an important behaviour needs clarification.
- Add a short migration note or example only for a breaking change.
- Leave implementation details, investigation, tests, rationale, and review
  history in the pull request.

If an entry needs headings, bullets, or multiple paragraphs, it is too long.

Bumping the vendored upstream devtools (`upstream.json` + `pnpm sync-upstream`)
changes what users see, so it takes a changeset too. Say what changed for the
user (new panel, fixed bug), not which commit was pulled in.

`privatePackages.version` is `false`, so the `playground` app is never bumped
and has no changelog.
