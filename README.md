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

> The package isn't published to npm yet (`"private": true`). Until it is,
> use it from this repo, e.g. as a workspace or `git` dependency.

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
patch signals before any are created. Put this at the very top of your entry
file:

```ts
import "preact-devtools-overlay/client"; // must come first
import "preact/debug";
import "@preact/signals-debug"; // only if you use signals

import "preact-devtools-overlay/auto"; // mounts the overlay UI
```

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
  theme variables can't clash with each other or with your page. The only
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
| `preact-devtools/0001-theme-root-in-shadow-dom.patch` | The theme class was put on `document.body`, which can't style anything inside a shadow root. |
| `signals/0001-shadow-dom-support.patch` | The theme model used `document.querySelector`, which can't see into a shadow root. The graph's click-outside handler used `e.target`, which is retargeted to the shadow host, so the export menu closed on any click. |

Don't edit `vendor/` by hand. To update upstream or change a patch:

```sh
# bump the ref in upstream.json, then:
pnpm sync-upstream            # re-vendor + re-apply patches
pnpm check-upstream           # CI: verify vendor/ == upstream + patches
```

To change a patch, edit the vendored file, then regenerate the patch with
`git diff --relative=packages/preact-devtools-overlay/vendor/<dir> > patches/<dir>/<name>.patch`
and check that `pnpm check-upstream` passes.

## Differences from the browser extensions

- **"Inspect DOM node"** and **"View source"** need privileged devtools APIs
  (`inspect()`). The overlay logs the DOM node or component function to the
  console instead, where the browser makes it clickable.
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
pnpm dev            # watch-build the package + run the playground
pnpm test           # unit tests (vitest)
pnpm test:e2e       # Playwright tests against the playground (Chromium + Firefox)
pnpm typecheck
```

## License

MIT. Vendored code keeps its upstream MIT license, see
`packages/preact-devtools-overlay/vendor/*/LICENSE`.
