# Proposal: Parallelize Mem0 Retrieval in the Middleware Chain

**To:** Davide
**From:** Jorge / Luis (voice-transport-migration worktree)
**Date:** 2026-04-21
**Spec refs:** `docs/specs/03_memory_system.md`, `docs/specs/04_backend_integration.md`, `CLAUDE.md` (middleware chain, hard constraint #11: RitualMiddleware position 11 before SkillRouter position 12)
**Status:** Proposal. Awaiting your sign-off before implementation.

---

## The ask

Let Mem0 retrieval start running *before* its current sequential slot at position 13, so the network round-trip overlaps with cheaper in-process middlewares. Keep ordering and category-selection semantics correct.

## Why

Current per-turn local timing (from `logs/langgraph.log` thread_id correlation, post-Mem0-log patch shipped earlier this session):

- `mem0.search_ms` is the single longest middleware on cache-miss turns (~300–1000 ms).
- On cache hits it's ~0–30 ms (60 s LRU TTL already in place).
- Every other middleware in positions 1–12 is <5 ms (file reads are preloaded, strings are joined, state is mutated in place).

The Mem0 network call currently blocks the entire pre-LLM pipeline even though most of its input is known earlier.

On a local dev turn this means ~300–800 ms idle on every non-cached turn before the Anthropic call even starts. In production (with Mem0 currently disabled) this proposal is a no-op; it matters for when memory is re-enabled in production per `CLAUDE.md`.

---

## Facts about ordering (what we can and can't move)

From `CLAUDE.md` middleware chain:

```
11. RitualMiddleware          ← sets state["active_ritual"], state["ritual_phase"]
12. SkillRouterMiddleware     ← reads ritual + tone_band, sets state["active_skill"]
13. Mem0MemoryMiddleware      ← reads active_skill + ritual + active_tone_band for category selection
```

**Hard constraint #11 says RitualMiddleware must be at position 11 before SkillRouter at position 12.** That is load-bearing and not negotiable.

**Mem0 category selection depends on `active_skill` AND `ritual` AND the user/person signals.** From `03_memory_system.md`:

```python
categories = ["fact", "preference"]                  # always
if ritual in {"prepare", "debrief"}:
    categories += ["commitment", "decision"]
if ritual == "vent":
    categories += ["feeling", "relationship"]
if ritual == "reset":
    categories += ["feeling", "pattern"]
if active_skill in {"vulnerability_holding", "trust_building"}:
    categories += ["feeling", "relationship"]
if active_skill == "challenging_growth":
    categories += ["pattern", "lesson"]
```

So Mem0 **cannot** simply be moved to position 1 — it needs `active_skill` which is set at position 12.

---

## Three options, with compromises

### Option 1 — Speculative prefetch with cancellation *(recommended)*

**Idea:** At the start of position 1, kick off a `retrieve_memories` task with the *baseline* categories (`["fact", "preference"]` + any inferable categories from user text signals like names and emotion words). By the time position 13 runs, the baseline task is either complete or nearly so. At position 13, examine the actual `active_skill` + `ritual`:

- If the speculative categories are a **superset** of what's needed → filter results in place, no extra call. ✅
- If the actual categories add 1–2 categories → run a small incremental call for just the additions, merge results.
- If the actual categories are completely disjoint → cancel the speculative task, run the correct one.

**Expected payoff:**
- ~80 % of turns hit case 1 or 2 (baseline categories almost always survive, ritual/skill add at most 2).
- Per-turn savings: ~200–700 ms on cache-miss turns.
- Zero savings on cache-hit turns (they were already fast).

**Compromise:**
- Extra Mem0 call budget on disjoint turns. Estimate ~5–10 % of turns pay a ~50 ms premium for the second call. Net still positive.
- Cognitive overhead in `Mem0MemoryMiddleware`: must track an in-flight task handle on state, and handle cancellation cleanly. Non-trivial to get right.
- Tests must cover: baseline-superset, incremental-merge, full-cancel, and baseline-task-fails-falls-back.

### Option 2 — Parallelize with other I/O-bound middlewares (not possible today)

Looking at positions 1–12, none currently do network I/O. They read preloaded files and mutate state. So there is nothing else network-shaped to parallelize *against*. This option is a non-starter given current middleware implementations. If in the future UserIdentityMiddleware or SessionStateMiddleware becomes I/O-bound (e.g., reading the identity file from S3 instead of local disk), Option 1's prefetch would naturally overlap with them.

### Option 3 — Run the top-5 most-likely category combinations in parallel

**Idea:** At position 11, before ritual/skill are final, issue 5 concurrent Mem0 searches — one per probable `(ritual, skill)` combination — and pick the correct result at position 13.

**Compromise:**
- 5× the Mem0 search cost per turn. Only viable if Mem0 has flat-rate pricing or if we're willing to take that cost for perceived latency.
- Wastes ~4 searches every turn.
- Easy to implement (just `asyncio.gather`), easy to reason about.

I don't recommend this unless Option 1 proves too fragile.

---

## Implementation sketch (Option 1)

```python
# Position 1: ThreadDataMiddleware or a new PrefetchMemoryMiddleware
async def before(self, state):
    # best-effort signal extraction from latest user message
    signals = infer_baseline_signals(state["messages"][-1])
    baseline_categories = ["fact", "preference"] + signals.category_hints
    state["_mem0_prefetch_task"] = asyncio.create_task(
        self.client.search(
            query=state["messages"][-1].content,
            user_id=state["user_id"],
            categories=baseline_categories,
            ttl_cache=True,
        )
    )
    state["_mem0_prefetch_categories"] = set(baseline_categories)
```

```python
# Position 13: Mem0MemoryMiddleware (modified)
async def before(self, state):
    actual_categories = set(select_categories(state))  # existing logic
    task = state.get("_mem0_prefetch_task")
    prefetch_cats = state.get("_mem0_prefetch_categories") or set()

    if task and actual_categories.issubset(prefetch_cats):
        # case 1: baseline covers it
        prefetch_result = await task
        memories = filter_by_categories(prefetch_result, actual_categories)
    elif task and actual_categories - prefetch_cats:
        # case 2: incremental
        baseline_result, incremental_result = await asyncio.gather(
            task,
            self.client.search(
                query=...,
                categories=list(actual_categories - prefetch_cats),
            ),
        )
        memories = merge_and_dedupe(baseline_result, incremental_result)
    else:
        # case 3: fully disjoint — cancel and redo
        if task and not task.done():
            task.cancel()
        memories = await self.client.search(categories=list(actual_categories))

    state["injected_memories"] = [m["id"] for m in memories]
    state["messages"].insert(...)  # existing memory injection
```

---

## Risks

1. **Cache-write correctness.** Mem0 writes already happen only in the offline pipeline (CLAUDE.md hard constraint #3). Prefetch is read-only. No new write path. ✅
2. **Crisis fast-path.** `CrisisCheckMiddleware` at position 2 sets `skip_expensive=True`. The prefetch task must be cancelled when `skip_expensive` is set. Must add a check at position 2 to cancel any in-flight prefetch.
3. **Task leak.** If an exception aborts the graph between positions 1 and 13, the prefetch task may linger. Solve by using `asyncio.shield` at prefetch site and a teardown hook in state.
4. **Over-fetching.** Baseline categories may return larger result sets than the actual call would. Filter ruthlessly before injection so we don't inflate the prompt.
5. **Observability.** Add `mem0.prefetch_hit` / `mem0.prefetch_miss` / `mem0.prefetch_cancelled` log lines so we can verify the 80 % hit-rate assumption post-deployment.

---

## Cost / payoff summary

| Metric | Before | After (Option 1) | Assumption |
|---|---|---|---|
| Mem0 search on cache-miss turn | ~500 ms blocking | ~100 ms blocking (the rest overlaps middlewares 2–12) | Middlewares 2–12 cost ~300–400 ms total |
| Mem0 search on cache-hit turn | ~10 ms | ~10 ms | Unchanged |
| Mem0 API calls per turn | 1.0 | 1.05–1.10 | ~5–10 % of turns pay incremental or disjoint |
| Code surface change | 0 | ~80 LOC, 1 new middleware + 1 modified | |

Net: meaningful latency win on the turn type users currently feel as slow; small cost increase on the turn type that was already fast.

---

## Recommendation

Approve Option 1 contingent on:

1. A/B log analysis over 50+ prod turns *after* Mem0 is re-enabled in production (separately from this change — see local-vs-production memo).
2. Crisis-path cancellation test coverage.
3. The prefetch-hit rate assumption (≥75 %) is verifiable via the new log lines before we mark the change stable.

If you want, we can ship this as a feature flag (`SOPHIA_MEM0_PREFETCH=1`) so it can be toggled without redeploy.
