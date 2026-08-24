# Sophia Voice Lab plugin

Private registered-app control surface for the deployed Sophia Voice Lab MCP service.

## Install

1. Deploy committed bootstrap candidate A kill-switched, then register its verified production `https://sophia-voice-lab-mcp.onrender.com/mcp` endpoint as a private remote MCP app and complete its OAuth authorization-code/PKCE consent once. Record the resulting technical app ID beginning `plugin_asdk_app`; never commit a token or consent secret.
2. Put that exact technical app ID in `.app.json`, add the manifest `apps` field, run the plugin-creator cachebuster, validate, and compute the final package hash twice. Commit those packaging bytes to `codex/sophia-observability-v1` as final candidate B; do not install an uncommitted overlay.
3. With every kill switch engaged, set the helper-exact `+codex.<single-sanitized-lowercase-token>` manifest version, package hash, registered app ID, candidate B SHA, and expected B SHAs on both lab services. Redeploy LangGraph, frontend, Gateway, Voice, MCP, and worker from exact B and verify every identity.
4. Add the repository marketplace with `codex plugin marketplace add "$(git rev-parse --show-toplevel)"`, install candidate B's `sophia-voice-lab` from the `personal` marketplace, and restart the supported Codex/ChatGPT client.
5. Open a fresh task that did not implement the service, confirm the `autonomous-voice-dogfood` skill and Voice Lab tools are discoverable, and call `get_capabilities` before starting a run.

The plugin targets `https://sophia-voice-lab-mcp.onrender.com/mcp`. Installation is not evidence of service health; the fresh task must complete the bounded start → speak → wait → inspect → end → export flow. A repository `.mcp.json` or static bearer connection is only a secondary preflight surface and cannot certify registered-app identity, installation, discoverability, or the V-P01 fresh-task gate.

## Security

The plugin contains no credentials. The registered lane uses OAuth 2.1 protected-resource metadata, authorization code with S256 PKCE, pinned client metadata, scoped short-lived access tokens, rotating refresh families, and durable revocation. A separately scoped static bearer may remain enabled only for direct-client preflight. The service additionally applies run-scoped authorization, target-origin, deployment, rolling spend, concurrency, duration, capture, and fault policies. Never paste grants, cookies, authorization headers, consent credentials, provider tokens, or continuation handles into a task.

See the bundled skill and references for the operational contract.
