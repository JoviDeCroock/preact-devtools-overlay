# Security

Report a vulnerability privately. On GitHub, open the Security tab and choose
**Report a vulnerability**:

https://github.com/JoviDeCroock/preact-devtools-overlay/security/advisories/new

Only the latest release is supported.

The MCP server and the agent API are a dev-only tool. They talk to a page
through the Vite dev server and are not part of a production build. The
bridge's security model is in the README under
[MCP server, for agents without a browser](README.md#mcp-server-for-agents-without-a-browser).
