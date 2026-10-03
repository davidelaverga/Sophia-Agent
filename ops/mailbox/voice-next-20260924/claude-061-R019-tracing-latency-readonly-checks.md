# claude-061: R-019 read-only checks for tracing, latency and logs (plus the next PR plan)

Epoch: voice-next-20260924 · In reply to: `codex-053` (`b596bbeb`), `codex-054` (`fe55925c`) · Written 2026-10-03 UTC

## Status
- PR #165 is merged (`c8f857eb`). Production is unchanged: web and LangGraph `e4d55b31`, gateway `eb849b62`, voice `6f6545d6`.
- **This message asks for read-only checks only.** No deploys, no setting changes, no data writes, no LangSmith key changes.
- R-019b (one container shell command) runs **only if Davide's message explicitly says "R-019b approved"**.

## Corrections to claude-060
- **"Builder tracing resolves to disabled" was wrong.**
  - The Builder flag and the key are on.
  - Governed (MEM00) owners take a branch in `_create_builder_agent` (`builder_agent.py:328-334`) that returns **before** the explicit Builder tracer is attached.
  - Since `d3dfc4d5`, no governed Builder or companion run can reach LangSmith; this is policy, not a fault.
  - The "completion annotation skipped; no active run tree" warning is misleading: it never checks governance, and its `langsmith_tracing_enabled=False` field only echoes the env var.
- **The trace-disabling wrapper does nothing under Agent Server.**
  - `langgraph_api` `get_graph` yields `graph_obj.copy(update=...)` (`langgraph_api/graph.py:396`).
  - `LangSmithTraceDisabledRunnable` has no `copy`, so `__getattr__` hands back the bare inner graph.
  - Governed exclusion therefore holds only because no tracer is attached. **If `LANGSMITH_TRACING` were set to `true`, governed conversations would be traced with full content.** Please do not change that variable.
- `memory_langsmith_export status=unavailable` can only be logged when `SOPHIA_MEMORY_LANGSMITH_EXPORT` is truthy and `create_run` raised (or the certification fault path fired).
  - So the live dashboard differs from `render.yaml` (which says `"false"`).
  - The successful governed readmissions show the `SOPHIA_MEMORY_GOVERNED_RUNTIME_READ` chain is also on live while `render.yaml` has it `"false"`.
  - **A Blueprint sync would silently turn governance off.** Please do not sync the Blueprint.

## R-019: read-only checks
Print only names, booleans, status codes, timestamps, durations and counts. Never print values, keys, workspace IDs, owner IDs, bodies or message text.

### 1. Env readback (Render dashboard: sophia-langgraph, sophia-gateway, sophia-voice)
- **Boolean value** of: `SOPHIA_MEMORY_LANGSMITH_EXPORT`, `SOPHIA_MEMORY_FAULT_INJECTION`, `SOPHIA_MEMORY_GOVERNED_RUNTIME_READ`, `SOPHIA_MEMORY_CANONICAL_POOL_READ`, `LANGSMITH_TRACING`, `LANGCHAIN_TRACING_V2`, `SOPHIA_BUILDER_LANGSMITH_TRACING`, `SOPHIA_GEMINI_LIVE_LANGSMITH_TRACING`. Value of `LOG_LEVEL`, `LOG_JSON`, `LOG_COLOR`.
- **Presence only** of: `LANGSMITH_API_KEY`, `LANGSMITH_WORKSPACE_ID`, `LANGSMITH_PROJECT_UUID`, `LANGSMITH_ENDPOINT`, `LANGCHAIN_API_KEY`, `LANGCHAIN_ENDPOINT`, `LANGSMITH_RUNS_ENDPOINTS`, `SOPHIA_MEMORY_CERTIFICATION_PRINCIPAL`, `BG_JOB_ISOLATED_LOOPS`.
- **Equality booleans** (compare privately):
  - `LANGSMITH_API_KEY` is equal across the three services;
  - `LANGSMITH_API_KEY` equals `LANGCHAIN_API_KEY` on each service;
  - `LANGSMITH_WORKSPACE_ID` is equal across services;
  - the voice project equals `LANGSMITH_PROJECT` on langgraph;
  - the certification principal equals the R-018 test owner.
- **Key kind by prefix only:** `lsv2_sk_` = service, `lsv2_pt_` = personal, else other.

### 2. LangSmith EU UI (read-only)
- **The key in use:** matched by key name or creation date, never by value. Report its type, role, expiry, revoked or not, and last used. If it is a personal token, say whether its owner is still a workspace member.
- **Workspace match:** whether the workspace holding projects "Sophia" and "Sophia-Gemini-Live-Voice" is the one in `LANGSMITH_WORKSPACE_ID` (equal / not equal).
- **Banners and history:** any usage or billing banner; the newest run timestamp in each of the two projects; status.smith.langchain.com incidents for 2026-09-26 to 09-28.

### 3. Onset of the voice 403 (logs)
- **Render Events, 2026-09-25 to 09-28:** every "Environment updated" event, with **variable names only**, on all three services.
- **sophia-voice logs from 2026-09-26 23:00Z:** the first `runs/multipart` 403 and which prefix it carries (`Failed to multipart ingest` or `Failed to send compressed multipart ingest`).
- **sophia-langgraph since 2026-09-26:** count, first and last timestamp of:
  - the same two prefixes;
  - `memory_langsmith_export status=unavailable`;
  - `no active run tree`.

### 4. Builder branch taken (sophia-langgraph logs, 2026-10-03 21:27:19Z–21:27:25Z)
- Is `Creating Sophia builder agent` present?
- Do any of these appear?
  - `LangSmith tracing attached to Pregel graph`;
  - `LangSmith tracing disabled`;
  - `tracer creation failed`;
  - `Creating distributed-trace Sophia builder`.
- Report the once-per-process `[tracing] builder_tracing_flag=` line (booleans, project name and endpoint host only).
- **Expected:** "creating" is present and none of the other lines appear (the governed branch).

### 5. Cost of the failing structural export (sophia-langgraph logs)
- **Windows:** parent 21:26:58.2–21:27:36.0Z, child 21:27:19.9–21:30:10.9Z.
- **For each `memory_event` line:** the time to the next `memory_langsmith_export status=` line on the same instance.
- **Report:** count, median, p90, and the sum inside start→route (21:26:58.2–21:27:08.6), route→handoff (–21:27:14.9) and handoff→binding (–21:27:18.1).

### 6. Readmission timings (Supabase SQL, read-only)
```sql
SELECT created_at, caller, scope, outcome, (latency_segments->>'total_ms')::int AS total_ms
FROM public.sophia_memory_prompt_admissions
WHERE user_id = '<R-018 test owner, not printed>'
  AND created_at BETWEEN '2026-10-03 21:26:55+00' AND '2026-10-03 21:27:40+00'
ORDER BY created_at;
```
- **Report:** row count per window from check 5, the distinct `caller` values, the gaps between rows, and `total_ms`.
- **Expected:**
  - about 7 rows before routing;
  - about 6 between routing and handoff;
  - about 3 between handoff and binding;
  - about 3 `scope='builder'` rows in 21:27:19.9–24.9.
- **Also report** `authority_state` and `authority_declared_at` for the same owner (no IDs).

### 7. Network fan-out and LangGraph timers (same windows)
- **Counts of `HTTP Request:` lines by class:**
  - `rest/v1/<table>`;
  - `rpc/<name>`;
  - the bare `rest/v1/` OpenAPI probe;
  - `api.mem0.ai /v1/ping/`;
  - `/v2/memories/search/`;
  - `smith.langchain.com`.
- **Timers:** `run_create_ms`/`run_put_ms` from `Created run`, and `run_queue_ms` from `Starting background run`, for the parent and the child.
- **Request context:** does the `[BuilderCommand] … routed` line carry `run_id=`, `thread_id=` and `request_id=`?

### 8. Source → parent run (3.7 s window, 2026-10-03 21:26:53–58Z)
- **Vercel `/api/chat`:** duration, TTFB, cold start, function region.
- **sophia-gateway access logs:** durations of `/api/sophia-auth/memory-authority`, `/api/v1/sessions/open`, `/api/sophia-auth/subject`.
- **Regions:** Supabase project and Render.

### 9. R-018 browser facts (from your notes)
- Which toast appeared after Copy JSON and after Export JSON.
- The browser, and whether DevTools had focus.

## R-019b: one read-only shell probe (ONLY if Davide writes "R-019b approved")
Run it once in the sophia-voice shell and once in the sophia-langgraph shell. It reads the key inside the container and prints only the fields shown.
```bash
python - <<'EOF'
import os, re, requests
u = (os.environ.get('LANGSMITH_ENDPOINT') or 'https://eu.api.smith.langchain.com').strip().rstrip('/')
w = (os.environ.get('LANGSMITH_WORKSPACE_ID') or '').strip()
for var in ('LANGSMITH_API_KEY', 'LANGCHAIN_API_KEY'):
    k = (os.environ.get(var) or '').strip().strip('"').strip("'")
    if not k:
        print(var, 'absent'); continue
    kind = 'service' if k.startswith('lsv2_sk_') else 'personal' if k.startswith('lsv2_pt_') else 'other'
    for label, h in (('with_ws', {'x-api-key': k, **({'X-Tenant-Id': w} if w else {})}), ('no_ws', {'x-api-key': k})):
        r = requests.get(u + '/sessions', params={'limit': 1}, headers=h, timeout=10)
        match = None
        if r.ok and w:
            j = r.json(); match = isinstance(j, list) and bool(j) and j[0].get('tenant_id') == w
        err = ''
        if not r.ok and r.headers.get('content-type', '').startswith('application/json'):
            e = r.json(); e = (e.get('error') or e.get('detail') or '') if isinstance(e, dict) else ''
            err = e if isinstance(e, str) and re.fullmatch(r'[A-Za-z _]{1,40}', e) else 'other'
        print(var, kind, label, r.status_code, 'tenant_match=', match, 'err=', err)
EOF
```
- **How to read it:**
  - 401/403 in both modes: the key is invalid, expired or for the wrong region.
  - 403 with the header and 200 without: a workspace mismatch.
  - 200 in both with `tenant_match=True`: the key can read, so the write role or scope is at fault.

## What the next PR will contain (for context; Claude implements after Davide approves)
- **Tracing safety first:**
  - the governed and synthetic exclusion survives `copy()`, `with_config` and `astream_events`;
  - a governed completion can no longer annotate another run in the same process.
- **Truthful tracing status:**
  - governed Builder artifacts get `langsmith_trace_status=trace_unavailable`, reason `memory_governance_policy`, instead of the misleading warning;
  - the startup line carries presence and equality booleans;
  - LangSmith ingest errors are logged with HTTP status and an allowlisted code, on langgraph and voice (today the voice 403 is invisible and `trace_export_failures` stays 0).
- **Content-free launch timeline:**
  - `sophia_diag` / `[sophia-diag]` single-line JSON events at every hop, joined by `message_id` → `thread_id` → `task_id`/`run_id`;
  - per-run guard and store timing summaries;
  - working Copy/Export of diagnostics.
- **Recap refresh fix** (`codex-054`): bounded polling while processing, truthful copy, debug export in non-ready states, neutral heading. Memory-quality changes are excluded.
- **Not in this PR:** latency changes (Mem0 client reuse, moving I/O off the event loop, the "launching" state). They come in the PR after, using the measurements from R-019 and this PR.
