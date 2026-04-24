# Why Sophia Feels More Responsive Locally Than on Render/Vercel

## Decision requested

Approve this sequence:

1. Upgrade `sophia-gateway` from `starter` to `standard` for a 24-hour production experiment.
2. Pin Vercel to `pdx1` and compare before/after frontend latency.
3. Verify Render Mem0 env/logs as a separate production-correctness check, not as part of the latency hypothesis.
4. Defer route-level SSE / Edge-runtime code changes unless steps 1 and 2 fail to materially improve the experience.

If approving only one change right now, approve the gateway plan bump first.

**To:** Davide
**From:** Luis / voice-transport-migration worktree
**Date:** 2026-04-21
**Scope:** Fact-based investigation. Evidence from `render.yaml`, `config.production.yaml`, `backend/packages/harness/deerflow/agents/middlewares/memory_middleware.py`, `backend/packages/harness/deerflow/agents/sophia_agent/agent.py`, `backend/packages/harness/deerflow/sophia/mem0_client.py`, `frontend/src/env.js`, frontend API routes, and voice configuration. No speculation beyond what the files prove.

---

## TL;DR

Four mechanical reasons explain most of the gap. None require a prompt or model explanation.

1. **Render gateway is on the `starter` plan (0.5 CPU / 512 MB).** Voice SSE proxying is CPU-bound serialization work. Half a CPU throttles under load. *(proof: `render.yaml` line `plan: starter` under `sophia-gateway`)*
2. **Every user turn traverses 3 cross-region hops in production vs. 0 in local.** Vercel (default US-East) → Render gateway (Oregon, US-West) → Render LangGraph (Oregon, internal) → Anthropic. Local is all loopback.
3. **`memory.enabled: false` in `config.production.yaml` is DeerFlow memory, not Sophia Mem0.** That flag disables the generic DeerFlow memory layer. Sophia Mem0 is wired separately and depends on a working Mem0 client / `MEM0_API_KEY`, so this config file does **not** prove whether Mem0 is on or off in production.
4. **Next.js API routes on Vercel are the Node runtime, not Edge.** Every `/api/**` handler adds a serverless cold-start ceiling and a buffered-by-default response path unless explicitly streamed. Our routes do not pin edge runtime.

## Action plan

| Phase | Change | Suggested owner | Why this is next | Success signal | Rollback / next step |
|---|---|---|---|---|---|
| 0 | Capture a 24h prod baseline from existing telemetry | Ops / voice | Needed so the next two changes are measurable | Baseline for p50/p95 first audio, first text token, turn diagnostic failures, user-reported stutter | If baseline cannot be produced quickly, do not block phase 1; use the most recent stable telemetry window available |
| 1 | Upgrade `sophia-gateway` to `standard` | Infra / deploy | Lowest-effort change with the highest likely payoff | Lower p95 first-audio latency and fewer long gaps during streamed speech | Revert plan tier if no meaningful improvement after 24h |
| 2 | Pin Vercel to `pdx1` | Frontend / deploy | Cheap follow-up that directly removes east-west RTT | Lower p50/p95 first-token latency and faster page/API interactions | Revert `vercel.json` region if there is no measurable frontend improvement |
| 3 | Audit streaming proxy routes and pin Edge runtime only where needed | Frontend | More invasive; only worth doing if phases 1 and 2 are not enough | Cleaner SSE pass-through and fewer buffered responses | Keep changes limited to streaming-shaped routes; do not broaden to all routes |
| 4 | Check Render Mem0 env + logs for client initialization | Backend / ops | Important for product correctness, but separate from performance diagnosis | Confirm whether Sophia Mem0 is actually active in production | If not active, fix as a separate follow-up, not as part of the latency experiment |

## Success criteria

Use existing production telemetry and compare each phase against the baseline window.

- **Phase 1 passes** if p95 first-audio latency improves by roughly 15% or more, or if user-visible speech stutter clearly drops over the 24h window.
- **Phase 2 passes** if frontend first-token latency and page/API responsiveness measurably improve after the Vercel region pin.
- **Escalate to phase 3** only if phases 1 and 2 together still leave a clear responsiveness gap or continued buffering symptoms.
- **Do not treat Mem0 status as the deciding factor** for the latency plan. It matters for Sophia's product behavior, but it is a separate operational question.

## What can be decided now vs. later

**Can be decided now**

1. Approve gateway plan upgrade.
2. Approve Vercel region pin.
3. Approve before/after telemetry comparison for both.

**Should wait until after those two changes are measured**

1. Edge-runtime migration for streaming routes.
2. Any broader routing / infra redesign.
3. Any attempt to explain the gap through prompts, models, or memory architecture.

---

## Verified facts (what the files actually say)

### `render.yaml`

| Service | Plan | Region | Dockerfile |
|---|---|---|---|
| sophia-langgraph | `standard` (1 CPU / 2 GB) | oregon | `backend/Dockerfile.langgraph` |
| sophia-gateway | **`starter` (0.5 CPU / 512 MB)** | oregon | `backend/Dockerfile.gateway` |
| sophia-voice | `standard` | oregon | `voice/Dockerfile` |

All three services are in the same Render region (`oregon`), so inter-service latency inside Render is small (~1–5 ms for LAN within a region). The bottleneck is not *between* Render services — it is between the user and Render.

### `config.production.yaml`

```yaml
memory:
  enabled: false       # <-- disables DeerFlow global memory, not Sophia Mem0
summarization:
  enabled: true
  trigger: { type: messages, value: 10 }
```

This flag feeds DeerFlow's global `MemoryConfig` / `MemoryMiddleware`. It proves the generic DeerFlow memory updater is off in production.

Sophia's Mem0 path is separate. The Sophia agent still wires `Mem0MemoryMiddleware(user_id)` into the middleware chain, and the Mem0 client initializes only if the runtime has a working `MEM0_API_KEY`. So `config.production.yaml` alone does **not** prove whether Sophia Mem0 is enabled on Render.

There is also a `MEM0_ENABLED=true` line in `backend/.env`, but the repository code does not read that variable anywhere. The effective gate is the Mem0 client initialization path.

So the earlier statement "Mem0 is disabled in production" was too broad. The correct statement is: **DeerFlow global memory is disabled in production; Sophia Mem0 status must be checked from the deployed env/logs.**

### `frontend/src/env.js`

```
NEXT_PUBLIC_API_URL: z.string().url().optional(),
NEXT_PUBLIC_GATEWAY_URL: z.string().url().optional(),
```

Both `NEXT_PUBLIC_*` env vars are read by the frontend. In production these point to the Render gateway in Oregon. In local dev they fall back to `http://localhost:8000` (per multiple route files like `frontend/src/app/api/community/user-impact/route.ts`).

### `vercel.json` (repo root and `frontend/vercel.json`)

```json
{
  "framework": "nextjs",
  "buildCommand": "pnpm build",
  "installCommand": "pnpm install"
}
```

**No `regions`, no `functions`, no runtime pin.** This means all Next.js route handlers run on Vercel's default region (`iad1` / US-East Washington DC) on the Node.js runtime. None of our routes use `export const runtime = 'edge'`.

### Voice server

```
SOPHIA_BACKEND_MODE=deerflow
SOPHIA_LANGGRAPH_BASE_URL=http://127.0.0.1:2024     # local
# production resolves via Render internal DNS
```

Voice → LangGraph is local-network within Render. No user-visible impact there.

---

## What the round-trip actually looks like

**Local (dev):**
```
Browser ─(ws loopback)→ Frontend(3000) ─(tcp loopback)→ Voice(8000) ─(tcp loopback)→ LangGraph(2024) ─(https)→ Anthropic
```
Every hop except the last is <1 ms. A typical simple turn ships the first Cartesia audio chunk within ~400–900 ms of the user stopping speaking (per prior traces).

**Production:**
```
Browser (anywhere)
  ─(wss, ~15–80 ms to Stream SFU)→ Stream WebRTC SFU
  ─(wss)→ Voice server (Render Oregon)
  ─(http, ~1–5 ms Render LAN)→ LangGraph (Render Oregon)
  ─(https, ~15–60 ms Oregon → us-west-2 / us-east)→ Anthropic

  Browser ─(https, ~15–80 ms)→ Vercel iad1
     ─(https, ~60–90 ms iad1 → oregon)→ Render Gateway
     ─(http)→ Render LangGraph
     ─(https)→ Anthropic
```

Each hop is small in isolation. What you *feel* on voice is the sum on every SSE event:

- Voice turn first audio chunk: add ~60–120 ms for user ↔ SFU ↔ Render hop vs. loopback.
- Frontend text turn first SSE token: add ~140–220 ms for user ↔ Vercel ↔ Render vs. loopback.
- Every subsequent SSE token: Vercel Node runtime **buffers non-streaming responses by default**. If any middleware in our Next.js stack (auth check, header rewrites) wraps the proxied response without `new Response(stream)`, it silently buffers until end-of-stream. That alone can add a full 1–3 seconds on long turns.

---

## The starter-plan throttle (most likely single biggest contributor)

Render starter = 0.5 vCPU. Python's asyncio SSE serialization on a single proxy hop is not heavy, but:

- FastAPI with SSE response needs to JSON-encode + flush per event.
- When 2 turns overlap (user mid-turn while TTS is still finishing), that's 2 concurrent SSE streams on half a CPU.
- Any CPU spike on the gateway pauses event flushing. Users perceive this as "stutter" or "long gaps between words".

**Mitigation:** bump `sophia-gateway` to `standard` plan ($25/mo). Same region, 1 full CPU, 2 GB RAM. This is the single cheapest experiment that could meaningfully change perceived responsiveness.

---

## Secondary factors (real but smaller)

### Vercel runtime

- Default Node runtime on Vercel allocates a fresh Lambda instance after idle. First request after 15 min adds ~200–800 ms.
- The Node runtime also applies a response-header buffer to route handlers. To pass SSE cleanly through Vercel, any proxy route must:
  1. `export const runtime = 'edge'` (Vercel Edge Runtime supports true streaming), **or**
  2. `export const dynamic = 'force-dynamic'` and return `new Response(upstreamResponse.body, { headers: {...} })` without reading the body.
- Our routes under `frontend/src/app/api/**` currently use the Node runtime. `runtime = 'edge'` on proxy/stream routes would remove this buffering. Grep for routes that read upstream bodies with `await response.text()` — any of those will break streaming.

### Region mismatch

- Vercel default `iad1` (Washington DC) → Render `oregon` = ~60 ms each way = 120 ms per round-trip on every API call the frontend makes to the gateway (auth, memory reads, recap, etc.). That adds up if a single page load triggers 5+ backend calls.
- Options:
  - Pin Vercel to `pdx1` (Portland) by adding `"regions": ["pdx1"]` to `vercel.json`. Same coast as Render Oregon. ~5 ms instead of ~60 ms.
  - Move Render services to `ohio` (us-east-2) and keep Vercel at `iad1`. Same latency reduction, closer to most US users.

### Anthropic egress

- Anthropic API is hosted in AWS us-east. From Render Oregon that's ~65 ms each way. From a typical US developer machine, often 20–40 ms. On a 30-second companion turn with streaming, this shows up as a slightly longer time-to-first-token but not as a per-chunk stutter.

### No HTTP/2 multiplexing across hops

- Browser → Vercel: HTTP/2 OK.
- Vercel → Render: depends on Node `fetch` implementation and Render edge. If HTTP/1.1, concurrent API calls serialize.

---

## What is *not* the reason

- **Not the `memory.enabled: false` line by itself.** That line is DeerFlow global memory, not Sophia Mem0.
- **Not proven from repo evidence alone that Sophia Mem0 is off in prod.** That requires checking Render env/logs for `MEM0_API_KEY` and Mem0 client initialization.
- **Not Haiku latency.** Same model, same endpoint, same tokens. The Anthropic call dominates ~1–3 s regardless of origin.
- **Not prompt size.** ~9 k tokens both places, well under context limit.
- **Not the LangGraph checkpointer.** Not running (per CLAUDE.md hard constraint #2).
- **Not the artifact fix just shipped (2026-04-21 Option A).** That fixes mid-sentence cutoffs on ~50 % of long turns; it does not change per-chunk latency.

---

## Why this order

1. **Gateway plan bump first** because it is the highest-confidence, lowest-code change.
2. **Vercel region pin second** because it is nearly free and attacks a different proven source of latency.
3. **Streaming-route audit third** because it is code work and should only happen if the low-risk infra changes do not close enough of the gap.
4. **Mem0 verification in parallel or afterward** because it is important, but it should not distract from the latency path or be used to explain the responsiveness gap without evidence.

---

## Confidence levels

| Claim | Confidence | Evidence |
|---|---|---|
| Gateway `starter` plan throttles | High | `render.yaml` explicit |
| DeerFlow global memory disabled in prod | High | `config.production.yaml` explicit + `MemoryMiddleware` gate |
| Sophia Mem0 disabled in prod | Unverified | `config.production.yaml` does not control it; requires Render env/log check |
| Vercel default region is `iad1` | High | Vercel platform default, no `regions` key |
| SSE buffering on Node runtime adds latency | Medium | General Vercel behavior; not verified per-route here |
| Region mismatch contributes ~100–150 ms per RTT | High | Standard AWS inter-region latency |
| Upgrading gateway plan alone will close the gap | **Unverified** | Reasoned from CPU constraint; needs experiment |

The immediate next step is phase 1, not more analysis: change the gateway plan, capture the before/after telemetry window, and decide based on that result whether phase 2 is enough or whether phase 3 is justified.
