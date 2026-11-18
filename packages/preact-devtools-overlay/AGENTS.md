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
  over the whole tree. Pass `{ hooks: false }` to skip the hooks.
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
//   state: { running: false, seconds: 0 }, hooks: null, signals: null,
//   contexts: null, context: null }
```

`hooks` lists `useState`/`useReducer`/`useSignal`/… values in call order.
Custom hooks are listed with their children. `signals` lists every signal the
component read during its last render, with its current value. `contexts`
lists the contexts it consumes (`useContext`, `contextType`) with their value
and the provider that supplies it:
`{ name: "Theme", value: "dark", provider: { id, path: "App > ThemeProvider > Theme.Provider" } }`.
A `provider` of `null` means no provider is mounted above it, so it gets the
default value.

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
| `context` | A consumed context's value changed. |
| `parent` | The parent re-rendered and passed new props with equal values. This is a candidate for `memo()`. |
| `force` | Nothing changed that we can see, e.g. `forceUpdate()`. |

`whyDidRender("TodoItem")` returns the last 5 renders of one component.
`startRecording()` and then `stopRecording({ format: "text" })` return the
renders and the signal updates in between.

### Components that remount

A component that unmounts and mounts again in the same commit loses its state
and DOM. That usually means an unstable or missing `key`, or a component type
that is created during render:

```js
await page.evaluate(() => __PREACT_DEVTOOLS_OVERLAY__.api.getRemounts({ format: "text" }));
// [22] App > RemountDemo > Inner remounted (no key: is the component type created during render, or the list unkeyed?)
// [40] App > TodoList > TodoItem remounted (key "0.31" → "0.77")
```

### Current value and readers of a signal

```js
await page.evaluate(() => __PREACT_DEVTOOLS_OVERLAY__.api.getSignals({ format: "text" }));
// todos = [{"id":1,"text":"Inspect a component","done":true},…] (signal, 1 updates, 4 subscribers, read by App #1938)
// remaining = 0 (computed, 1 updates, 1 subscribers)
// (anonymous signal) = 0 (signal, 0 updates, 2 subscribers, created by SignalCounter #1940)
```

This lists every signal and computed created since page load, including ones
that were never read or never changed. Pass `{ limit }` to see more than 200,
or `{ name }` to see one. A computed's value is its cached value: listing
never makes a computed run.

`getSignalUpdates({ since, format: "text" })` shows what changed and in which
order. `getSignalGraph()` returns `{ nodes, links }`, including the
components that read each signal. Give signals a name
(`signal(value, { name: "todos" })`) so they're easy to find. Signal data
needs `@preact/signals-debug`, which the Vite plugin adds when the project
uses signals.

### Leaked effects and signals created on every render

```js
await page.evaluate(() => __PREACT_DEVTOOLS_OVERLAY__.api.getLeaks({ format: "text" }));
// LeakyTicker: 1 effect (leakyEffect) still running after it unmounted. Dispose it in a cleanup, or use useSignalEffect().
// Chart #52: 12 computeds alive, created during 12 of its 12 re-renders. Create it once: useSignal(), useComputed(), useSignalEffect() or useMemo().
```

This only knows about effects and signals that a component creates while it
renders. Effects created later, e.g. in a `useEffect` callback, have no
owner. A component is reported for creating on re-render only when it did so
on at least two re-renders and on more than half of them, so a `useMemo`
whose dependencies changed now and then doesn't count, and neither does one
the component keeps in a hook (`useMemo`, `useRef`, `useState`). Each
component instance is its own row.

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

## Keeping the overlay UI out of the way

For agent and CI runs, turn off the UI. The hooks and the API keep working:

```ts
preactDevtoolsOverlay({ overlay: process.env.CI ? false : true });
```

Or add `?devtools=off` to the page URL, which affects only that page load.

If you read the console rather than calling the API, use
`signalsConsoleLogging: "compact"` for one line per signal update:

```txt
[signals] signal todos[0].done: false → true
[signals] App re-rendered (todos)
```

Otherwise the launcher button sits in the bottom-right corner. It shows up in
screenshots and can sit on top of elements you want to click.
