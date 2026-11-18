# Preact devtools for coding agents

With `preact-devtools-overlay` installed, every page served by the Vite dev
server exposes the devtools as data on
`window.__PREACT_DEVTOOLS_OVERLAY__.api`. Use it from Playwright
(`page.evaluate`), CDP (`Runtime.evaluate`), a browser MCP server's
"evaluate" tool, or the console. You don't need to open the overlay UI.

```js
__PREACT_DEVTOOLS_OVERLAY__.api.help(); // the full method list
```

Things to know before you start:

- **Targets.** Methods that take a component accept a devtools id (a number),
  a DOM element inside the component, a component name (`"TodoItem"`, which
  must start with an uppercase letter) or a CSS selector
  (`"[data-testid=save]"`). Ids change on every page load, so don't hard-code
  them.
- **Text output.** Most queries take `{ format: "text" }`. It returns one
  line per item and costs far fewer tokens than JSON.
- **History.** Renders (last 500) and signal updates (last 2000) are recorded
  from page load. Use `mark()` to get a cursor, then pass `{ since }` to read
  only what happened after it.
- **Values.** Values are capped in depth, breadth and string length.
  Functions, DOM nodes and vnodes become short strings, and signals become
  `{ $signal, value }`. Getters show up as `"[Getter]"` and are not run.
  Reading values never subscribes to a signal. `inspect()` output is also
  cut to `maxBytes` (default 20,000). To read hooks, `inspect()` re-runs them
  the way the Components tab does when you select a component. That includes
  serializing their values in full, so call it per component, not in a loop
  over the whole tree.
- **Missing API.** If `api` is `undefined`, the agent API is disabled
  (`agentApi: false`, or a production build). If `api.status().renderers` is
  `0`, Preact hasn't attached: `preact/debug` was not loaded, or loaded too
  late.

## Recipes

### Dump the component tree

```js
await page.evaluate(() => __PREACT_DEVTOOLS_OVERLAY__.api.getTree({ format: "text" }));
// App #1938
//   Counter #1939
//   Stopwatch #1941 [class]
//   TodoItem #1942 [key="1"]
```

Use `{ root: "TodoList", depth: 2 }` to show only part of the tree.

### Inspect the component under a selector

```js
await page.evaluate(() =>
	__PREACT_DEVTOOLS_OVERLAY__.api.inspect("[data-testid=stopwatch]"),
);
// { id, name: "Stopwatch", kind: "class", path: "App > Stopwatch",
//   source: "/src/main.tsx:37:1", props: { label: "Class stopwatch" },
//   state: { running: false, seconds: 0 }, hooks: null, signals: null, context: null }
```

`hooks` lists `useState`/`useReducer`/`useSignal`/… values in call order.
Custom hooks are listed with their children. `signals` lists every signal the
component read during its last render, with its current value.

### What re-rendered after an interaction, and why?

```js
const since = await page.evaluate(() => __PREACT_DEVTOOLS_OVERLAY__.api.mark());
await page.getByRole("checkbox").first().click();
await page.evaluate(
	since => __PREACT_DEVTOOLS_OVERLAY__.api.getRenders({ since, format: "text" }),
	since,
);
// [18] commit 4: App #1938 signal (todos[0].done: false → true) 0.5ms
// [19] commit 4: Stopwatch #1941 parent 0.1ms
// [20] commit 4: TodoItem #1942 props (todo.done: false → true) 0ms
// [21] commit 4: TodoItem #1943 parent 0ms
```

The reasons are:

| Reason | Meaning |
| --- | --- |
| `mount` | First render. |
| `signal` | A signal the component read changed. |
| `hooks` | A `useState`/`useReducer` value changed. |
| `state` | Class component `state` changed. |
| `props` | A prop changed value. |
| `parent` | The parent re-rendered and passed new props with equal values. This is a candidate for `memo()`. |
| `force` | Nothing changed that we can see: `forceUpdate()` or a context change. |

`whyDidRender("TodoItem")` returns the last 5 renders of one component.
`startRecording()` and then `stopRecording({ format: "text" })` return the
renders and the signal updates in between.

### Current value and readers of a signal

```js
await page.evaluate(() => __PREACT_DEVTOOLS_OVERLAY__.api.getSignals({ format: "text" }));
// todos = [{"id":1,"text":"Inspect a component","done":true},…] (signal, 1 updates, read by App #1938)
// remaining = 0 (computed, 1 updates)
```

`getSignalUpdates({ since, format: "text" })` shows what changed and in which
order. `getSignalGraph()` returns `{ nodes, links }`, including the
components that read each signal. Give signals a name
(`signal(value, { name: "todos" })`) so they're easy to find. Signal data
needs `@preact/signals-debug`, which the Vite plugin adds when the project
uses signals.

### Edit state to test a hypothesis

```js
await page.evaluate(() => {
	const api = __PREACT_DEVTOOLS_OVERLAY__.api;
	api.update("Counter", "hook", 0, 41); // hook index from inspect().hooks
	api.update("Stopwatch", "state", "seconds", 10);
	api.update("TodoItem", "props", "todo.done", true); // until the parent re-renders
	api.update("App", "signal", 0, []); // sets the signal's .value; index from inspect().signals
});
```

## Without a browser: the MCP server

If you can't drive a browser, use the `preact-devtools-overlay-mcp` MCP
server. The page still has to be open somewhere (ask the user to open it);
the Vite dev server relays each call to that tab.

```sh
claude mcp add preact-devtools -- npx preact-devtools-overlay-mcp
```

Or in `.mcp.json`:

```json
{ "mcpServers": { "preact-devtools": { "command": "npx", "args": ["preact-devtools-overlay-mcp"] } } }
```

The tools map to the methods above and return text by default: `get_tree`,
`find`, `inspect`, `why_did_render`, `get_renders`, `mark`, `get_signals`,
`get_signal_updates`, `get_signal_graph`, `status`, `list_tabs`. Targets
work the same, and `"#12"` is read as id 12.

- It finds the dev server through
  `node_modules/.cache/preact-devtools-overlay/server.json` (URL and token)
  in its working directory, a parent or a subdirectory. Pass
  `--root <vite root>` if it can't.
- With several tabs open, calls go to the most recently focused visible tab.
  Pass `tab` (an id from `list_tabs`, or part of the URL) to pick one.
- To see what an interaction caused: `mark`, have the user (or an HMR
  update) do it, then `get_renders` with `since`.
- `update` is refused unless the project sets
  `preactDevtoolsOverlay({ agentBridge: { allowUpdate: true } })`.
- "No browser tab is connected": nobody has the app open, or the page isn't
  served by this dev server. A timeout means the tab is paused in the
  debugger, frozen in the background, or still loading.

Without MCP, POST `{ method, args, tab? }` to
`/__preact-devtools-overlay/api` with `Authorization: Bearer <token>` (from
`server.json`). `GET /__preact-devtools-overlay/tabs` lists the tabs.

## Keeping the overlay UI out of the way

For agent and CI runs, turn off the UI. The hooks and the API keep working:

```ts
preactDevtoolsOverlay({ overlay: process.env.CI ? false : true });
```

Otherwise the launcher button sits in the bottom-right corner. It shows up in
screenshots and can sit on top of elements you want to click.
