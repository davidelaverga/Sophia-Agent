# Registered-app packaging

Plugin registration requires two committed source identities. Bootstrap candidate A carries a
valid pre-registration plugin: the workflow skill and secondary `.mcp.json` preflight connection
are present, while `.app.json` and the manifest `apps` field are absent. Final candidate B is a
later commit on `codex/sophia-observability-v1` that carries the real registered-app mapping and
the plugin-creator cachebuster. Do not install candidate A or treat its preflight bundle as the
private registered app.

## Pre-registration checks

From the repository root, validate the current bundle with the current plugin-creator validator:

```bash
uv sync --project backend --group dev
backend/.venv/bin/python \
  ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  plugins/sophia-voice-lab
python3 plugins/sophia-voice-lab/scripts/hash_plugin_package.py --json
```

Commit and push the completed pre-registration tree to the target branch as bootstrap candidate A
before deploying it. Capture its commit SHA, the exact manifest version (initially `0.1.0`), and
tree hash as `BOOTSTRAP_CANDIDATE_A_SHA`, `BOOTSTRAP_PLUGIN_VERSION`, and
`BOOTSTRAP_PLUGIN_SHA256`. Set candidate A, the bootstrap version, and the bootstrap hash on both
kill-switched Voice Lab services; leave `SOPHIA_VOICE_LAB_REGISTERED_APP_ID` blank. These values
exist only to boot the HTTPS registration endpoint and cannot satisfy private-install, P01, or
campaign evidence. The final version and package hash are unknowable until the real registered-app
mapping has been added.

## Finalize only after registration

1. Deploy bootstrap candidate A to LangGraph, frontend, Gateway, Voice, MCP, and worker with every
   mutation gate disabled and each kill switch engaged. Verify the exact A identity on all six
   processes, then verify the public HTTPS `/mcp` endpoint and OAuth discovery/PKCE flow.
2. In ChatGPT developer mode, register that exact endpoint and copy the technical ID from the
   resulting connection URL. It must begin with `plugin_asdk_app`. The ID is not a credential, but
   it must be the real value returned by registration; do not invent one.
3. Add `plugins/sophia-voice-lab/.app.json` with this exact shape, replacing the marker with the
   registered technical ID:

   ```json
   {
     "apps": {
       "sophia-voice-lab": {
         "id": "<REGISTERED_PLUGIN_ASDK_APP_ID>",
         "category": "Developer Tools"
       }
     }
   }
   ```

4. Add `"apps": "./.app.json"` to `.codex-plugin/plugin.json`. Keep `.mcp.json` only as the
   explicitly secondary direct-client preflight connection; it is not registered-app evidence.
5. Replace the local plugin cachebuster through the plugin-creator workflow, run the validator
   again, then compute the final tree hash twice and require an exact match. The helper preserves
   the base version and emits strict SemVer build metadata in the form
   `<base-version>+codex.<cachebuster>`. Its default token is a 14-digit UTC timestamp; a manual
   token is lowercased, non-alphanumeric runs become one hyphen, repeated hyphens collapse, and
   leading/trailing hyphens are removed. The final token is therefore exactly one
   `[a-z0-9]+(?:-[a-z0-9]+)*` identifier. Record the complete manifest value, including build
   metadata, as `FINAL_PLUGIN_VERSION`:

   ```bash
   python3 ~/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py \
     plugins/sophia-voice-lab
   backend/.venv/bin/python \
     ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
     plugins/sophia-voice-lab
   PLUGIN_SHA256="$(python3 plugins/sophia-voice-lab/scripts/hash_plugin_package.py)"
   python3 plugins/sophia-voice-lab/scripts/hash_plugin_package.py --check "$PLUGIN_SHA256"
   ```

   `sophia-plugin-tree-sha256-v1` hashes every regular file under the plugin root in byte-sorted
   relative-path order. Each record binds the UTF-8 path, content length, and SHA-256 of the file
   bytes. Timestamps, ownership, and host file modes are excluded. Symlinks, transient files,
   credential-bearing filenames, private keys, and common literal token forms fail closed.
6. Commit `.app.json`, the manifest `apps` field, and the cachebuster version to
   `codex/sophia-observability-v1` as packaging-finalization candidate B. Record the exact commit as
   `FINAL_CANDIDATE_B_SHA`, push it, and require the target branch to resolve to that SHA. Candidate
   B—not an uncommitted local overlay—is the final campaign source identity.
7. Keep every kill switch engaged. Redeploy LangGraph, frontend, Gateway, Voice, MCP, and worker
   from exact candidate B. On both Voice Lab services, replace the bootstrap identity with all of:
   `SOPHIA_VOICE_LAB_REPOSITORY_CANDIDATE_SHA=FINAL_CANDIDATE_B_SHA`, the four expected product and
   LangGraph SHAs set to B, `SOPHIA_VOICE_LAB_PLUGIN_VERSION=FINAL_PLUGIN_VERSION`,
   `SOPHIA_VOICE_LAB_PLUGIN_PACKAGE_SHA256=PLUGIN_SHA256`, and the real
   `SOPHIA_VOICE_LAB_REGISTERED_APP_ID`. The plugin version, hash, and app ID are dashboard-managed
   and identical on MCP and worker.
8. Require all six public/worker identities to report candidate B and require MCP capability and
   readiness output to echo the exact final version, package hash, and registered app ID before
   installation or any mutation. A process still running A, a service still echoing
   `BOOTSTRAP_PLUGIN_SHA256`, or a version with missing/malformed `+codex.*` metadata is bootstrap
   infrastructure only and cannot pass P01.

## Private marketplace and install

The repository marketplace is at `.agents/plugins/marketplace.json`, names the marketplace
`personal`, and resolves `./plugins/sophia-voice-lab` from the repository root. After the final
bundle validates, configure and install it with:

```bash
codex plugin marketplace add "$(git rev-parse --show-toplevel)"
codex plugin marketplace list
codex plugin add sophia-voice-lab@personal --json
codex plugin list --json
```

If another configured marketplace already uses the name `personal`, stop and resolve the naming
collision before installation. Do not install from an ambiguous marketplace snapshot. Restart the
supported client and use the P01 official-source collector documented in
`tools/sophia-voice-lab/scripts/external-attestations/README.md`. The collector repeats the exact
JSON add/list checks, launches the signed Codex App Server, and records the fresh task; an operator
transcript, screenshot, copied task JSON, or hand-authored install receipt is not acceptable P01
evidence.

Registration and installation are deliberate production operations. They are not performed by
repository tests or preflight, and they must not run until the public MCP/OAuth endpoint, real
`plugin_asdk_app…` mapping, final package SHA-256, deployment identities, and kill switch have all
been verified.

The bundle must never contain OAuth secrets, bearer values, cookies, authorization headers,
provider keys, storage state, attestation private keys, or continuation handles.
