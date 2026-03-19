# Sophia Memory System
## Mem0 Configuration, Retrieval, Handoffs, Smart Opener, Reflection
**Version:** 7.0 · March 2026
**Backend:** Mem0 Platform (managed)
**Retrieval:** Rule-based category selection + semantic search within categories + LRU cache
**Filesystem:** Handoff files + identity file (session continuity layer)
---
## 1. Design Principles
**P1: Mem0 is the single memory backend.** No custom vault. Mem0 handles storage, retrieval, deduplication, and graph relations. Filesystem stores only handoffs and identity summary.
**P2: Categories are the type system.** Nine custom categories replace undifferentiated fact storage. Every memory has semantic type. Retrieval is filtered by type — not brute-forced by confidence score.
**P3: Rule-based category selection, semantic search within.** Which categories to query is determined deterministically in Python (zero latency). Finding the best matches within those categories uses Mem0's vector search. These two steps must remain separated — the rule logic lives in the middleware, not in the agent loop.
**P4: No MCP for per-turn retrieval.** The Python SDK calls Mem0 directly from the middleware process. MCP adds a network hop in the most latency-sensitive path. MCP is not appropriate here.
**P5: Ingestion control over retrieval sophistication.** Better to store the right things than to retrieve cleverly from noise. Custom instructions gate what enters Mem0. The extraction prompt is the quality bottleneck — invest there.
**P6: Timestamps on everything.** Every write includes explicit timestamp. Contextual memories expire after 7 days. Time-range filtering enables temporal queries for the reflect flow.
**P7: Session grouping via run_id.** Each session writes memories with `run_id=session_id`. Episodic recall: "what happened in that session?" = `client.get_all(filters={run_id: session_id})`.
---
## 2. Mem0 Project Configuration
### 2.1 Custom Categories
```python
custom_categories = [
    {"fact": "Static user information — name, job, location, life context. High stability."},
    {"feeling": "Emotional patterns and reactions. Always include tone context in metadata."},
    {"decision": "Important choices the user made or committed to. Only genuine decisions, not considerations."},
    {"lesson": "Insights the user expressed, realized, or learned from experience."},
    {"commitment": "Goals, deadlines, stated intentions, obligations accepted."},
    {"preference": "Communication style, interaction preferences, how they want to be treated."},
    {"relationship": "People in the user's life — names, roles, dynamics, connection patterns."},
    {"pattern": "Recurring behavioral observations by Sophia. Require 2+ session evidence."},
    {"ritual_context": "How the user uses each Sophia ritual — what works, what doesn't, preferences."},
]
client.project.update(custom_categories=custom_categories)
```
### 2.2 Custom Instructions (Ingestion Control)
```python
custom_instructions = """
STORE confirmed observations only. Each memory: one specific, evidence-based fact.
STORE:
- Confirmed facts stated by the user (name, job, relationships, life events)
- Emotional patterns observed (with tone context in metadata)
- Decisions the user explicitly made or committed to
- Insights the user articulated or realized
- Communication preferences stated or demonstrated
- Goals and deadlines the user set
- People the user mentioned with relationship context
- Behavioral patterns Sophia observed (only if evidence exists in this session)
IGNORE:
- Speculation (might, maybe, possibly, I think)
- Session logistics (ritual selection, greetings, closings)
- Temporary emotional reactions that don't represent patterns
- Generic observations that could apply to anyone
- Information about Sophia (store facts about the USER)
- Duplicate information already in memory
Content should be specific enough that reading it later recreates the context.
Not "user was upset" but "user was upset about being overlooked for the project lead
role after preparing for three months."
"""
client.project.update(custom_instructions=custom_instructions)
```
### 2.3 Entity Partitioning
Every write includes full entity scoping:
```python
client.add(
    messages,
    user_id=user_id,              # links to user identity
    agent_id="sophia_companion",   # separates companion from builder path
    run_id=session_id,             # groups memories by session
    timestamp=turn_timestamp,      # Unix epoch
    metadata={
        "tone_estimate": 1.4,
        "ritual_phase": "debrief.step2_what_worked",
        "importance": "structural",    # structural | potential | contextual
        "platform": "voice",           # voice | text | ios_voice
        "status": "pending_review",    # candidates flow
        "context_mode": "work",        # work | gaming | life
    }
)
```
### 2.4 Graph Memory
```python
client.project.update(enable_graph=True)
```
Graph memory creates entity relationships automatically. Search results include a `relations` array (person → role, decision → project). Used by the reflect flow for entity-connected queries.
### 2.5 Retention Policy
| Importance | Expiration | When to use |
|------------|-----------|-------------|
| Structural (≥ 0.8) | Permanent | Facts, decisions, core relationships, confirmed patterns |
| Potential (0.4–0.79) | None (long-term) | Preferences, feelings, single-session insights |
| Contextual (< 0.4) | 7 days | Routine observations, temporary states |
---
## 3. Per-Turn Memory Retrieval
### 3.1 The Mem0MemoryMiddleware Before-Phase
```python
def retrieve_for_turn(message, user_id, ritual, context_mode, active_skill, previous_artifact):
    # Step 1: Rule-based category selection (zero latency, in Python)
    categories = ["fact", "preference"]  # always relevant
    if ritual in ["prepare", "debrief"]:
        categories.extend(["commitment", "decision"])
    if ritual == "vent":
        categories.extend(["feeling", "relationship"])
    if ritual == "reset":
        categories.extend(["feeling", "pattern"])
    if active_skill in ["vulnerability_holding", "trust_building"]:
        categories.extend(["feeling", "relationship"])
    if active_skill == "challenging_growth":
        categories.extend(["pattern", "lesson"])
    if ritual:
        categories.append("ritual_context")
    if person_mentioned(message):
        categories.append("relationship")
    if emotion_signal(message):
        categories.append("feeling")
    categories = list(set(categories))
    # Step 2: Cached semantic search within selected categories
    results = cached_search(
        user_id=user_id,
        categories=categories,
        query=message,
        filters={"NOT": {"metadata.status": "pending_review"}},
    )
    # Step 3: Sort by importance + recency
    memories = results["results"]
    memories.sort(key=lambda m: (
        m.get("metadata", {}).get("importance", 0.5),
        m["created_at"]
    ), reverse=True)
    return format_memories(memories[:10])  # ~750 token budget
```
### 3.2 LRU Cache Implementation
```python
# backend/src/sophia/mem0_client.py
import hashlib, time
_cache: dict = {}  # {key: (result, expires_at)}
CACHE_TTL = 60     # seconds — memories don't change mid-session
def cached_search(user_id, categories, query, filters=None):
    cat_hash = hashlib.md5(",".join(sorted(categories)).encode()).hexdigest()[:6]
    query_hash = hashlib.md5(query.encode()).hexdigest()[:6]
    key = f"{user_id}:{cat_hash}:{query_hash}"
    now = time.time()
    if key in _cache and _cache[key][1] > now:
        return _cache[key][0]
    result = mem0_client.search(
        query=query,
        filters={"AND": [
            {"user_id": user_id},
            {"categories": {"in": categories}},
            *(filters or {})
        ]},
        enable_graph=True,
        keyword_search=True
    )
    _cache[key] = (result, now + CACHE_TTL)
    return result
def invalidate_user_cache(user_id):
    """Called after any write to Mem0 for this user."""
    keys_to_delete = [k for k in _cache if k.startswith(f"{user_id}:")]
    for k in keys_to_delete:
        del _cache[k]
```
### 3.3 The retrieve_memories Tool (Agent-Initiated)
Available to the companion agent for targeted deep retrieval beyond the baseline injection:
```python
# backend/src/sophia/tools/retrieve_memories.py
from langchain_core.tools import tool
@tool
def retrieve_memories(query: str, categories: list[str] | None = None) -> str:
    """
    Retrieve memories relevant to what the user just said or asked about.
    Use this when you need specific context the baseline injection didn't surface:
    - User mentions a specific person → retrieve_memories("relationship with [name]", ["relationship"])
    - User references a past decision → retrieve_memories("decision about X", ["decision", "lesson"])
    - Reflect flow → multiple targeted calls with different queries
    Do NOT call this on every turn — the baseline injection handles routine context.
    Only call when you detect a specific gap.
    """
    categories = categories or ["fact", "feeling", "decision", "lesson",
                                  "commitment", "preference", "relationship",
                                  "pattern", "ritual_context"]
    result = cached_search(
        user_id=runtime.config["user_id"],
        categories=categories,
        query=query
    )
    return format_memories(result["results"][:8])
```
---
## 4. Memory Writing
### 4.1 During Conversation
The per-turn Mem0 write (DeerFlow's native MemoryMiddleware) is **disabled** (`memory: enabled: false` in config.yaml). Writing happens only in the post-session offline pipeline. This prevents per-turn API calls adding to latency, and gives the extraction pipeline full session context before writing.
### 4.2 Post-Session Extraction Pipeline
Full detail in §6 (Offline Pipeline). The extraction uses Claude Haiku + `mem0_extraction.md` prompt. Each observation is written to Mem0 with `status: "pending_review"`. The extraction prompt is in `backend/src/sophia/prompts/mem0_extraction.md` — NOT in the skills directory.
---
## 5. Memory Candidates Flow
The existing implementation (already working) handles:
- `GET /api/sophia/{user_id}/memories/recent?status=pending_review` — fetch pending
- `PUT /api/sophia/{user_id}/memories/{id}` — keep (set status=active) or edit
- `DELETE /api/sophia/{user_id}/memories/{id}` — discard
**Auto-promotion:** Background job after 48 hours removes `pending_review` from unreviewed memories → status becomes `active`. Baseline retrieval only queries `active` memories.
---
## 6. The Offline Post-Session Pipeline
Triggers: 10-minute inactivity timeout on thread OR explicit WebRTC disconnect signal. Pipeline is idempotent — safe to run twice if both triggers fire.
```
Session ends (timeout or disconnect)
    │
    ▼ Step 1: Smart opener generation (~$0.0005)
    Read: handoff latest.md (previous) + this session's artifacts + Mem0 session memories
    Prompt: smart_opener_assembly.md
    Output: one sentence written to latest.md frontmatter as smart_opener
    │
    ▼ Step 2: Handoff write (~$0.001)
    Read: this session's artifacts + Mem0 session memories
    Prompt: session_state_assembly.md (in backend/src/sophia/prompts/)
    Output: overwrite users/{user_id}/handoffs/latest.md
    │
    ▼ Step 3: Mem0 extraction (~$0.002)
    Read: conversation transcript + artifacts
    Prompt: mem0_extraction.md (in backend/src/sophia/prompts/)
    Output: observations written to Mem0 with status=pending_review
    Invalidate cache: invalidate_user_cache(user_id)
    │
    ▼ Step 4: In-app notification
    Signal frontend: new pending memories available for review
    │
    ▼ Step 5: Trace aggregation
    Flag golden turns: tone_delta >= +0.5
    Write to users/{user_id}/traces/{session_id}.json
    │
    ▼ Step 6 (conditional: sessions_since_update >= 10 OR new structural memory)
    Identity file update (~$0.003)
    Read: all Mem0 categories + recent handoffs
    Prompt: identity_file_update.md (in backend/src/sophia/prompts/)
    Output: overwrite users/{user_id}/identity.md
    │
    ▼ Step 7 (conditional: sessions_this_week >= 3)
    Visual artifact generation
    Query: Mem0 weekly data → generate artifact → notify frontend (Insights tab updated)
```
---
## 7. The Smart Opener System
### 7.1 What It Is
A single warm, context-aware sentence written at session END for Sophia to use at the START of the next session. Replaces the generic cold open.
### 7.2 Generation Prompt (smart_opener_assembly.md)
```
You are generating Sophia's opening line for the user's NEXT session.
You have no knowledge of which ritual or context mode they will choose —
write an opener that works regardless.
Inputs:
- Previous handoff: {previous_handoff}
- This session's final tone_estimate: {final_tone}
- Session feeling note: {feeling}
- Days since last session: {days_elapsed}
Rules:
1. One sentence. Maximum 20 words. No more.
2. Specific > warm. "The pitch is tomorrow" beats "How are you?"
3. If there's a time-sensitive thread (event, deadline, pending conversation),
   reference it. That's the opener.
4. If the session ended low (tone < 1.5), open gently — no pressure, no agenda.
   "How are you doing today?" is correct here.
5. If 3+ days have elapsed with no sessions, acknowledge the gap naturally.
   "It's been a few days. Where are you at?"
6. Never reference the ritual. Never assume they want to do the same thing again.
7. After a breakthrough session: "Something shifted last time. How does it feel now?"
Output: ONLY the opener sentence. No quotes, no preamble, no explanation.
```
### 7.3 Storage
Written to `handoffs/latest.md` YAML frontmatter:
```yaml
---
schema_version: 1
session: sophia:debrief:2026-03-15
created: 2026-03-15T18:30:00Z
ritual_phase: debrief
smart_opener: "The conversation with Marco — did that happen?"
---
```
### 7.4 Injection
`SessionStateMiddleware` reads `smart_opener` from the frontmatter. When `state["messages"]` has length 0 (first turn of session), it injects:
```
FIRST TURN INSTRUCTION (deliver this, then remove from subsequent turns):
Open with this phrasing, adapted naturally for the platform:
"{smart_opener}"
Platform adaptation:
- Voice: Speak it as your opening line. One sentence. Then wait.
- Text: Type it as your first message. One sentence. Then wait.
```
On subsequent turns, `state["turn_count"] > 0`, and the instruction is not injected.
---
## 8. Session Continuity Layer (Filesystem)
### 8.1 Handoff File
**Path:** `users/{user_id}/handoffs/latest.md`
Always overwritten — never accumulate. Previous handoff context is folded into the new one by the assembly prompt. Single file, single read on session start.
**Schema:**
```yaml
---
schema_version: 1
session: sophia:{ritual_type}:{session_date}
created: {iso_timestamp}
ritual_phase: {ritual_type}
smart_opener: "{generated opener sentence}"
---
## Summary (max 300 chars)
[What this session was about. How it ended. Forward-looking signal for Sophia.]
## Tone Arc
{band} ({score}) → {band} ({score}) — [one observation about movement]
tone_estimate_final: {final_tone}
## Next Steps
[3 gentle seeds for future sessions. Not assignments.]
## Decisions (max 200 chars)
[Genuine decisions only. "Decided to X." Not "considered X."]
## Open Threads (max 200 chars)
[Topics approached but unresolved. Return only if user opens the door.]
## What Worked / What Didn't (max 200 chars)
[Specific enough to guide Sophia's approach next session.]
## Feeling
[One sentence capturing the session's emotional texture.]
```
### 8.2 Identity File
**Path:** `users/{user_id}/identity.md`
Updated every 10 sessions or when a structural-importance memory is added to Mem0. Prompt template: `backend/src/sophia/prompts/identity_file_update.md`. Assembled from all 9 Mem0 categories + recent handoffs.
Sections: Communication Profile · Emotional Patterns · Life Context Map · Session Patterns · What Works · Evolution Notes. ~650 tokens total.
**Update trigger condition:**
```python
def should_update_identity(user_id, session_count):
    # Condition 1: session interval
    if session_count % 10 == 0:
        return True
    # Condition 2: new structural memory added this session
    recent = mem0_client.get_all(filters={
        "AND": [
            {"user_id": user_id},
            {"run_id": current_session_id},
            {"metadata.importance": {"gte": 0.8}},
        ]
    })
    return len(recent["results"]) > 0
```
---
## 9. The Reflect Flow
User-triggered: button in app or voice phrase "Sophia, reflect on this."
```python
async def handle_reflect(user_id, query, mem0_client):
    # 1. Classify intent
    period = classify_period(query)   # this_week | this_month | overall
    theme = classify_theme(query)     # topic string or None
    # 2. Query Mem0 — category-filtered
    patterns = mem0_client.search(
        query=theme or "patterns and themes",
        filters={
            "AND": [
                {"user_id": user_id},
                {"categories": {"in": ["pattern", "feeling", "lesson"]}},
                {"created_at": {"gte": period_start}},
            ]
        },
        enable_graph=True,
        rerank=True
    )
    # 3. Widen if insufficient
    if len(patterns["results"]) < 3:
        patterns = mem0_client.search(
            query=theme or "any significant memories",
            filters={"AND": [{"user_id": user_id}]},
        )
    # 4. Tone trajectory from artifact metadata
    all_recent = mem0_client.get_all(
        filters={"AND": [
            {"user_id": user_id},
            {"created_at": {"gte": period_start}},
        ]}
    )
    tone_data = [
        {"date": m["created_at"], "tone": m["metadata"].get("tone_estimate")}
        for m in all_recent["results"]
        if m.get("metadata", {}).get("tone_estimate") is not None
    ]
    # 5. Generate via reflect_prompt.md
    return await generate_reflection(patterns, tone_data, identity_summary)
```
Reflect output schema: `voice_context` (spoken narrative) + `visual_parts` (typed chart/card data). See reflect_prompt.md for full output specification.
---
## 10. Future Evolution Path
If Mem0 proves insufficient, criteria for moving to a filesystem vault:
1. Reflect flow consistently fails to find relevant memories → retrieval gap
2. GEPA memory optimization cycle is too friction-heavy → optimization gap
3. Graph queries require multi-hop traversal Mem0 can't support → reasoning gap
Until those criteria are met in production, Mem0 is the correct choice. Decision based on evidence, not speculation.
