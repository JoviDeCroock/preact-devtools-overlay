---
"preact-devtools-overlay": minor
---

Devtools data for coding agents and scripts on `window.__PREACT_DEVTOOLS_OVERLAY__.api` (on by default on the dev server, `agentApi` option): the component tree, `find()`, `inspect()` (props, state, hooks, signals, consumed contexts and their provider, source location) and `update()`. Every render is recorded from page load with why it happened and the values that changed (`getRenders()`, `whyDidRender()`, `mark()`, `startRecording()`), along with signals, their dependency graph and updates (`getSignals()`, `getSignalGraph()`, `getSignalUpdates()`). Most calls take `format: "text"` for compact output. See `AGENTS.md` in the package for recipes.

Also adds `overlay: false` and `?devtools=off` to keep the UI out of agents' way, and `signalsConsoleLogging: "compact"` for one plain console line per signal update.
