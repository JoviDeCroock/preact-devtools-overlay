# preact-devtools-overlay

## 0.1.0

### Minor Changes

- [#2](https://github.com/JoviDeCroock/preact-devtools-overlay/pull/2) [`efda6f2`](https://github.com/JoviDeCroock/preact-devtools-overlay/commit/efda6f21979687c5605c20435e36e49838ae5cd5) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Devtools data for coding agents and scripts on `window.__PREACT_DEVTOOLS_OVERLAY__.api` (on by default on the dev server, `agentApi` option): the component tree, `find()`, `inspect()` (props, state, hooks, signals, consumed contexts and their provider, source location) and `update()`. Every render is recorded from page load with why it happened and the values that changed (`getRenders()`, `whyDidRender()`, `mark()`, `startRecording()`), along with signals, their dependency graph and updates (`getSignals()`, `getSignalGraph()`, `getSignalUpdates()`). Most calls take `format: "text"` for compact output. See `AGENTS.md` in the package for recipes.
  
  Also adds `overlay: false` and `?devtools=off` to keep the UI out of agents' way, and `signalsConsoleLogging: "compact"` for one plain console line per signal update.

- [`efebbf4`](https://github.com/JoviDeCroock/preact-devtools-overlay/commit/efebbf49399c80f7b35365169e43bcca5f70a36f) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Hooks are named after the variable they're assigned to: `const [count] = useState(0)` shows as `count` in the Hooks panel, in `inspect().hooks` (`{ hook: "useState", name: "count" }`) and in render reasons (`count: 0 → 1` instead of `useState[0]: 0 → 1`). The Vite plugin applies the same transform as @preact/preset-vite's `devToolsEnabled`, which is usually turned off next to this plugin. Opt out with `hookNames: false`.

- [#2](https://github.com/JoviDeCroock/preact-devtools-overlay/pull/2) [`9041fa2`](https://github.com/JoviDeCroock/preact-devtools-overlay/commit/9041fa280f6fd599382318bd13e8ed3d0daffb07) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Initial release: Preact Devtools and the Preact Signals devtools in one in-page `<preact-devtools-overlay>` panel, with a Vite plugin that sets it up.

- [#2](https://github.com/JoviDeCroock/preact-devtools-overlay/pull/2) [`efda6f2`](https://github.com/JoviDeCroock/preact-devtools-overlay/commit/efda6f21979687c5605c20435e36e49838ae5cd5) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - New Insights tab. For the selected component, it shows:
  
  - why it rendered, with values;
  - the signals it reads;
  - the provider of each context it consumes;
  - where it's rendered, with an "Open in editor" button.
  
  It also has a live render log and an inventory of all signals with the components that read them. Components that unmount and remount in the same commit (key problems) and signal effects that outlive their component (leaks) are flagged. The agent API exposes the same data through `getRemounts()`, `getLeaks()` and `getSignals()`.
  
  On the Vite dev server, the Components tab's "View source" now opens the file in your editor through Vite's `/__open-in-editor`.

- [#2](https://github.com/JoviDeCroock/preact-devtools-overlay/pull/2) [`efda6f2`](https://github.com/JoviDeCroock/preact-devtools-overlay/commit/efda6f21979687c5605c20435e36e49838ae5cd5) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - MCP server for agents that can't drive a browser: `preact-devtools-overlay-mcp` (also `preact-devtools-overlay/mcp`) relays the agent API to a tab open in the Vite dev server (`agentBridge` option). Only callers on this machine can reach it, and they need a per-server token, which is kept in the user's cache directory where Vite can't serve it. Changing app state with `update` stays off unless you set `allowUpdate`.

### Patch Changes

- [#2](https://github.com/JoviDeCroock/preact-devtools-overlay/pull/2) [`efda6f2`](https://github.com/JoviDeCroock/preact-devtools-overlay/commit/efda6f21979687c5605c20435e36e49838ae5cd5) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Built from upstream preact-devtools and @preact/signals now that preactjs/preact-devtools#527 and preactjs/signals#1005 are merged, with no local patches left.
