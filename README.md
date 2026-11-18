# preact-devtools-overlay

[Preact Devtools](https://github.com/preactjs/preact-devtools) and the
[Preact Signals devtools](https://github.com/preactjs/signals/tree/main/packages/devtools-ui)
in a single in-page panel. No browser extension needed.

- **Components**: the full preact-devtools UI (element tree, props/state/hooks
  editing, element picker, highlight updates, profiler, statistics).
- **Signals**: the signals devtools UI (updates, performance insights,
  timeline, dependency graph).

It ships as a `<preact-devtools-overlay>` web component plus a Vite plugin
that wires everything up.

## Usage with Vite

```sh
pnpm add -D preact-devtools-overlay
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { preactDevtoolsOverlay } from "preact-devtools-overlay/vite";

export default defineConfig({
	plugins: [
		// The overlay plugin imports `preact/debug` itself.
		preact({ devToolsEnabled: false }),
		preactDevtoolsOverlay(),
	],
});
```

That's it. Run `vite`, then click the Preact button in the bottom-right
corner or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>.

By default the plugin only runs on the dev server, so production builds are
untouched.

### Options

```ts
preactDevtoolsOverlay({
	// "serve" (default) | "build" | "always"
	apply: "serve",
	// Import `preact/debug` for you. Default: true
	preactDebug: true,
	// Enable the Signals panel via `@preact/signals-debug`.
	// "auto" (default) enables it when `@preact/signals` or
	// `@preact/signals-core` is installed.
	signals: "auto",
	// signals-debug logs every update to the console by default. Default: false
	signalsConsoleLogging: false,
	// false to only install the hooks, or the initial UI state.
	overlay: { open: false, tab: "components", position: "bottom-right" },
});
```

## Usage without Vite

Two things have to happen **before** your app code runs: the devtools hook
has to be installed before Preact loads, and `@preact/signals-debug` has to
patch signals before any are created. Install `@preact/signals-debug`
yourself (it must resolve to the same `@preact/signals-core` as your app):

```sh
pnpm add -D @preact/signals-debug
```

Then put this at the very top of your entry file:

```ts
// Must come first: installs window.__PREACT_DEVTOOLS__.
import { configureSignalsDebug } from "preact-devtools-overlay/client";
import "preact/debug";
// Only if you use signals:
import { setDebugOptions } from "@preact/signals-debug";
configureSignalsDebug(setDebugOptions, { consoleLogging: false });

import "preact-devtools-overlay/auto"; // mounts the overlay UI
```

`configureSignalsDebug` turns off signals-debug's default console logging
(every update is logged otherwise) and keeps the Signals panel's settings in
sync with that. If you only import `@preact/signals-debug`, logging stays on.

Or mount the overlay yourself:

```ts
import { mountOverlay } from "preact-devtools-overlay";

const overlay = mountOverlay({ open: true, tab: "signals" });
overlay.toggle();
```

`<preact-devtools-overlay>` can also be used as plain HTML once
`defineOverlayElement()` has been called. It supports the `open`, `tab`
(`components` | `signals`) and `position` (`bottom-right` | `bottom-left` |
`top-right` | `top-left`) attributes and exposes `launcher` and `drawer` CSS
parts.

## How it works

```txt
 page                                                  overlay (shadow DOM)
┌───────────────────────────────┐   postMessage   ┌───────────────────────────────┐
│ preact/debug                  │ ──────────────► │ Components pane               │
│   └► __PREACT_DEVTOOLS__ hook │ ◄────────────── │  preact-devtools view + store │
│      (preact-devtools adapter)│                 │  (own shadow root)            │
│                               │                 │                               │
│ @preact/signals-debug         │  direct calls   │ Signals pane                  │
│   └► __PREACT_SIGNALS_DEVTOOLS__ ◄───────────── │  signals devtools-ui          │
│                               │                 │  (own shadow root)            │
└───────────────────────────────┘                 └───────────────────────────────┘
```

- `preact-devtools-overlay/client` is the in-page equivalent of the
  extension's content script: it installs `window.__PREACT_DEVTOOLS__` using
  the unmodified preact-devtools adapter. The Components pane talks to it
  over `window.postMessage`, using the same protocol the extension relays.
- The Signals pane uses the signals devtools' `DirectAdapter`, which talks to
  `@preact/signals-debug` in the same window.
- Both UIs are bundled with **their own private copy of Preact and
  `@preact/signals`**. Otherwise the devtools would inspect themselves:
  `preact/debug` hooks into the app's Preact `options`, and
  `@preact/signals-debug` patches the app's `Signal.prototype`.
  `@preact/signals-debug` itself is *not* bundled. It has to share the app's
  `@preact/signals-core` instance, so the Vite plugin pre-bundles it alongside
  the app's dependencies.
- Each UI lives in its own nested shadow root, so their global resets and
  theme variables can't clash with each other or with your page. `rem`
  units are compiled to `px`, because a shadow root can't isolate them from
  the page's root font size. The only
  thing added to the page's own `<head>` is the stylesheet for the element
  highlighter that preact-devtools draws over your app.
- Both panes are code-split and only load when first opened.

## Upstream code

The devtools UIs are vendored from upstream at pinned commits (see
[`upstream.json`](./upstream.json)) into
`packages/preact-devtools-overlay/vendor/`, with a few small patches for
Shadow DOM support in [`patches/`](./patches):

| Patch | Why |
| --- | --- |
| `preact-devtools/0001-shadow-dom-support.patch` | The theme class was put on `document.body`, which can't style anything inside a shadow root. `useResize` also listens for a `preact-devtools:container-resize` event, so the virtualized tree re-measures when the drawer (not the window) changes size. |
| `signals/0001-shadow-dom-support.patch` | The theme model used `document.querySelector`, which can't see into a shadow root, and it ran before the panel existed, so a stored theme wasn't applied on first render. The graph's click-outside handler used `e.target`, which is retargeted to the shadow host, so the export menu closed on any click. |

`vendor/` is committed with the patches already applied.

```sh
# Update upstream: bump the ref in upstream.json, then
pnpm sync-upstream            # re-vendor + re-apply patches (fails loudly if one doesn't apply)

# Change a patch: edit the files in vendor/ directly, then
pnpm update-patches           # rewrite patches/<name>/*.patch from vendor/ vs. pristine upstream

pnpm check-upstream           # (CI) verify vendor/ == upstream + patches
```

## Differences from the browser extensions

- **"Inspect DOM node"** and **"View source"** need privileged devtools APIs
  (`inspect()`). The overlay logs the DOM node or component function to the
  console instead, where the browser makes it clickable.
- **Reload and profile / record stats** work, but the page reloads with the
  panel. The overlay reopens on its own and replays what the hook recorded
  in the meantime. Custom component filters aren't applied during that
  recording. If the app sends more than 20,000 messages before the overlay
  opens, the recording is discarded (with a console warning) rather than
  shown incomplete.
- If the Preact Devtools **browser extension** is installed, it defines
  `__PREACT_DEVTOOLS__` first. The overlay then reuses the extension's hook
  (it speaks the same protocol) instead of replacing it.
- The Signals panel relies on `@preact/signals-debug` and the app resolving
  to the **same** `@preact/signals-core`. If your app pins a version of
  signals-core that doesn't satisfy `@preact/signals-debug`'s peer range, you
  may end up with two copies and an empty Signals panel.

## Development

```sh
pnpm install
pnpm build          # build the package
pnpm dev            # watch-build the package + run the playground (/?rows=200 for a big tree)
pnpm test           # unit tests (vitest)
pnpm test:types     # strict consumer check of the published types
pnpm test:e2e       # Playwright tests against the playground (Chromium + Firefox)
pnpm typecheck
pnpm changeset      # describe a user-facing change (see .changeset/README.md)
```

### Releasing

Releases go through [changesets](https://github.com/changesets/changesets):

1. Every PR that changes the package adds a changeset (`pnpm changeset`).
2. On `main`, the Release workflow keeps a "Version Packages" PR open that
   bumps the version and writes `CHANGELOG.md`.
3. Merging that PR runs the `publish` job in the `npm` environment (only
   allowed from `main`). It *stages* the new version on npm via trusted
   publishing (OIDC, no token) and creates the git tag and GitHub release.
4. Approve the staged version with `npm stage approve <stage-id>` (the id is
   in the job log).

## License

MIT. Vendored code keeps its upstream MIT license, see
`packages/preact-devtools-overlay/vendor/*/LICENSE`.
