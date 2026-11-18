---
"preact-devtools-overlay": minor
---

New Insights tab. For the selected component, it shows:

- why it rendered, with values;
- the signals it reads;
- the provider of each context it consumes;
- where it's rendered, with an "Open in editor" button.

It also has a live render log and an inventory of all signals with the components that read them. Components that unmount and remount in the same commit (key problems) and signal effects that outlive their component (leaks) are flagged. The agent API exposes the same data through `getRemounts()`, `getLeaks()` and `getSignals()`.

On the Vite dev server, the Components tab's "View source" now opens the file in your editor through Vite's `/__open-in-editor`.
