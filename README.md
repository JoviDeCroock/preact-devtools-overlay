# preact-devtools-overlay

[Preact Devtools](https://github.com/preactjs/preact-devtools) and the
[Preact Signals devtools](https://github.com/preactjs/signals/tree/main/packages/devtools-ui)
in a single in-page panel. No browser extension needed.

- **Components**: the full preact-devtools UI (element tree, props/state/hooks
  editing, element picker, highlight updates, profiler, statistics).
- **Signals**: the signals devtools UI (updates, performance insights,
  timeline, dependency graph).

- **Agent API**: the same information as data on
  `window.__PREACT_DEVTOOLS_OVERLAY__.api`, for AI coding agents and
  scripts, including why every component rendered, and an MCP server for
  agents that can't drive a browser. See [Agent API](#agent-api).

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
	// Expose window.__PREACT_DEVTOOLS_OVERLAY__.api and record renders.
	// Default: true on the dev server, false in builds.
	agentApi: true,
	// Let the MCP server reach the API through the dev server (see below).
	// Default: true when agentApi is on. Dev server only.
	agentBridge: { allowRemote: false, allowUpdate: false, timeout: 10_000 },
	// false to only install the hooks (the agent API keeps working),
	// or the initial UI state.
	overlay: { open: false, tab: "components", position: "bottom-right" },
});
```

## Agent API

Coding agents drive the browser through Playwright, CDP or an MCP server.
They can't do much with a virtualized tree or an SVG graph, so the client
also exposes the devtools as plain data:

```js
const api = window.__PREACT_DEVTOOLS_OVERLAY__.api;
api.getTree({ format: "text" });          // indented component tree
api.inspect("[data-testid=save]");        // props, state, hooks, signals, source location
const since = api.mark();
// …click something…
api.getRenders({ since, format: "text" });
// [20] commit 4: TodoItem #1942 props (todo.done: false → true) 0ms
api.getSignals({ format: "text" });       // values and which components read them
api.update("Counter", "hook", 0, 41);     // edit state to test a hypothesis
```

Renders (with the reason: `mount`, `signal`, `hooks`, `state`, `props`,
`parent` or `force`, plus the values that changed) and signal updates are
recorded from page load, before any panel is opened. `api.help()` lists
every method. [`AGENTS.md`](./packages/preact-devtools-overlay/AGENTS.md)
(also shipped in the npm package) has copy-paste recipes; point your agent
at it.

For agent and CI runs, pass `overlay: false` to keep the launcher button out
of screenshots and away from clicks. Recording renders adds a little work to
every commit. Turn it off with `agentApi: false`. Without Vite, set
`window.__PREACT_DEVTOOLS_OVERLAY_CONFIG__ = { agentApi: false }` before the
client loads.

### MCP server, for agents without a browser

An agent that can't drive a browser can still read the devtools of a page
that someone has open. The package ships a stdio MCP server,
`preact-devtools-overlay-mcp`. It asks the Vite dev server, and the dev
server relays the call to the tab over its HMR websocket:

```txt
agent ─MCP─► preact-devtools-overlay-mcp ─HTTP─► vite dev server ─HMR websocket─► tab: api.getTree()
```

Claude Code, from the project directory:

```sh
claude mcp add preact-devtools -- npx preact-devtools-overlay-mcp
```

Or in `.mcp.json` (most other clients use the same shape):

```json
{
	"mcpServers": {
		"preact-devtools": {
			"command": "npx",
			"args": ["preact-devtools-overlay-mcp"]
		}
	}
}
```

Tools: `list_tabs`, `get_tree`, `find`, `inspect`, `why_did_render`,
`get_renders`, `mark`, `get_signals`, `get_signal_updates`,
`get_signal_graph`, `status` and `update`. They return the compact text
format by default.

- **Finding the dev server.** On startup the dev server writes its URL and a
  random token to `node_modules/.cache/preact-devtools-overlay/server.json`
  under the Vite root, readable only by your user. The MCP server looks for
  that file in its working directory, the parents, and two levels of
  subdirectories (for monorepos). Pass `--root apps/web` to point it
  somewhere else, or `--url` and `--token`. The file is read on every call,
  so restarting Vite is fine.
- **Which tab.** Every page served by the dev server registers itself with
  its URL, title, visibility and focus. Calls go to the most recently focused
  visible tab. Every tool takes a `tab` argument: an id from `list_tabs`, or
  part of the URL (`"/settings"`).
- **Security.** The endpoints (`POST /__preact-devtools-overlay/api` and
  `GET /__preact-devtools-overlay/tabs`) run code in your page, and the dev
  server is reachable from your network with `--host`. So they need the
  token, only accept connections from this machine, and refuse requests that
  carry an `Origin` header (that is, requests from web pages). Tabs opened
  from other machines are not registered either. Set
  `agentBridge: { allowRemote: true }` to accept both from the network; the
  token is still required. `update()` changes app state, so the bridge
  refuses it unless you set `agentBridge: { allowUpdate: true }`.
  `agentBridge: false` turns the endpoints off.
- **Limits.** The page must be open, and answer within 10 seconds
  (`agentBridge.timeout`); a tab paused in the debugger or frozen in the
  background times out. With `server.https`, Node has to trust the
  certificate (`NODE_EXTRA_CA_CERTS`). In Vite's middleware mode the dev
  server doesn't know its URL, so pass `--url`.

Without MCP, any HTTP client works:

```sh
TOKEN=$(node -p 'require("./node_modules/.cache/preact-devtools-overlay/server.json").token')
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:5173/__preact-devtools-overlay/api \
	-d '{ "method": "getTree", "args": [{ "format": "text" }] }'
# { "ok": true, "result": "App #1938\n  Counter #1939\n…", "tab": { "id": "1", "url": "http://localhost:5173/", … } }
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
- Both panes are code-split and only load when first opened. The client
  subscribes to `@preact/signals-debug` right away, so the Signals pane
  still shows the updates from before it was opened.
- The agent API keeps its own copy of the component tree, decoded from the
  same messages the Components pane receives. It also adds `options` hooks
  next to the adapter's to record why each component rendered.

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
pnpm test:e2e       # Playwright tests against the playground (Chromium + Firefox, port 5297 or $E2E_PORT)
pnpm typecheck
```

## License

MIT. Vendored code keeps its upstream MIT license, see
`packages/preact-devtools-overlay/vendor/*/LICENSE`.
