# preact-devtools-overlay

Preact Devtools and the Preact Signals devtools in a single in-page panel:
a `<preact-devtools-overlay>` web component plus a Vite plugin.

```ts
// vite.config.ts
import preact from "@preact/preset-vite";
import { preactDevtoolsOverlay } from "preact-devtools-overlay/vite";

export default {
	plugins: [preact({ devToolsEnabled: false }), preactDevtoolsOverlay()],
};
```

Open it with the Preact button in the corner or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>.

Entry points:

- `preact-devtools-overlay/vite`: Vite plugin (dev server only by default)
- `preact-devtools-overlay/client`: page hook. Must load before Preact.
  Also exports `configureSignalsDebug()`.
- `preact-devtools-overlay`: `mountOverlay()`, `defineOverlayElement()`,
  `PreactDevtoolsOverlay`
- `preact-devtools-overlay/auto`: mounts the overlay once the DOM is ready
- `preact-devtools-overlay/mcp` and the `preact-devtools-overlay-mcp` bin:
  stdio MCP server that reads the agent API of a tab open in the Vite dev
  server

On the dev server, the devtools are also available as data for coding
agents on `window.__PREACT_DEVTOOLS_OVERLAY__.api`: the component tree,
inspection, why each component rendered, and signals. See `AGENTS.md` in
this package for recipes. Agents without a browser can use the MCP server:
`claude mcp add preact-devtools -- npx preact-devtools-overlay-mcp`.

See the repository README for usage without Vite, options, and how it works.
Contains code vendored from preactjs/preact-devtools and preactjs/signals
(MIT), see `NOTICE.md` and `vendor/*/LICENSE`.
