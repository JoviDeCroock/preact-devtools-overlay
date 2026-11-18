---
"preact-devtools-overlay": minor
---

MCP server for agents that can't drive a browser: `preact-devtools-overlay-mcp` (also `preact-devtools-overlay/mcp`) relays the agent API to a tab open in the Vite dev server (`agentBridge` option). Only callers on this machine can reach it, and they need a per-server token, which is kept in the user's cache directory where Vite can't serve it. Changing app state with `update` stays off unless you set `allowUpdate`.
