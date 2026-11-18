---
"preact-devtools-overlay": minor
---

Hooks are named after the variable they're assigned to: `const [count] = useState(0)` shows as `count` in the Hooks panel, in `inspect().hooks` (`{ hook: "useState", name: "count" }`) and in render reasons (`count: 0 → 1` instead of `useState[0]: 0 → 1`). The Vite plugin applies the same transform as @preact/preset-vite's `devToolsEnabled`, which is usually turned off next to this plugin. Opt out with `hookNames: false`.
