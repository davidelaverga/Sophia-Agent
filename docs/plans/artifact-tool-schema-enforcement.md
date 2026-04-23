# Proposal: Option B — Tool Schema Enforcement for `emit_artifact`

**To:** Davide
**From:** Luis / voice-transport-migration worktree
**Date:** 2026-04-21
**Spec refs:** `CLAUDE.md` (hard constraint #4: "emit_artifact is required on every companion turn, via tool_use. Never via text parsing. Anthropic guarantees valid JSON on tool calls.")
**Context:** Option A has already shipped — the voice adapter now fills neutral defaults for calibration fields when Haiku omits them, so turns no longer fail mid-TTS. Option B is a structural alternative that would let us remove those defaults and restore strict fidelity.
**Status:** Proposal. **Needs your sign-off** because it touches the artifact contract and surfaces an Anthropic-side guarantee that we depended on in CLAUDE.md but which turned out to hold less reliably than assumed.

---

## The observation that prompted this

Per `logs/voice.log` on 2026-04-21 session `12207dab`, 4 of 8 turns failed strict validation with:

```
backend-contract: artifact missing required fields:
    active_tone_band, reflection, ritual_phase, skill_loaded, tone_estimate, tone_target
```

The `emit_artifact` tool_use call itself was well-formed JSON. Haiku just elided 5–6 fields.

This is surprising because **the existing tool schema already declares those fields required**. From `backend/packages/harness/deerflow/sophia/tools/emit_artifact.py`:

```python
class ArtifactInput(BaseModel):
    session_goal: str                     # required
    active_goal: str                      # required
    next_step: str                        # required
    takeaway: str                         # required
    reflection: str | None                # OPTIONAL — only nullable field
    tone_estimate: float                  # required
    tone_target: float                    # required
    active_tone_band: str                 # required
    skill_loaded: str                     # required
    ritual_phase: str                     # required
    voice_emotion_primary: str            # required
    voice_emotion_secondary: str          # required
    voice_speed: Literal[...]             # required
```

The Pydantic model → LangChain `@tool(args_schema=ArtifactInput)` → Anthropic `tools[].input_schema` pipeline should produce an `input_schema` where all of the above except `reflection` are in the `"required"` JSON Schema array.

**So Haiku is violating a tool-schema `required` constraint that is already in place.** That contradicts CLAUDE.md's assumption that "Anthropic guarantees valid JSON on tool calls." Anthropic guarantees *syntactically* valid JSON. It does *not* guarantee that the model will populate every `required` field on every call — especially on long tool_use calls where the response preceded the tool call and the model is under token pressure.

This changes what "Option B" actually means.

---

## What Option B originally proposed

When we drafted options A/B/C/D, B was described as:

> Make the `emit_artifact` JSON schema set `required: [all 12 structural+calibration fields]`. Anthropic guarantees valid JSON on tool_use when required is specified.

**That's what we already have.** The Pydantic `str` (without `| None` or `Field(default=...)`) produces `required`. So Option B as originally framed is a no-op — it's the current state, and it's not enough.

## What Option B should mean instead

Three candidate enforcement strategies, increasingly heavy:

### B.1 — Explicit JSON schema (avoid Pydantic translation surprises)

Replace `@tool(args_schema=ArtifactInput)` with an explicit `StructuredTool` that declares the schema directly. This eliminates any risk that the Pydantic-to-JSON-Schema conversion silently loses `required` markers (for example, recent versions of Pydantic have handled `Literal` fields inconsistently in some LangChain adapters).

**Compromise:** Doesn't actually fix the underlying model behavior. Haiku ignores `required` on some long turns regardless. This is a preparation step, not a solution.

**Cost:** ~30 LOC change. Zero runtime impact. Easier to review.

### B.2 — Retry on missing required fields (model-side correction)

When the artifact validator (backend or voice adapter) detects missing required calibration fields, issue a *follow-up* tool call asking Haiku to re-emit the artifact with the missing fields, passing the already-populated fields as context so the model only has to complete the gaps.

**Compromise:**
- Adds one extra model round-trip on ~10–50 % of long turns (per current observation rate).
- Extra ~400–900 ms latency on affected turns.
- Requires the retry to happen *before* voice TTS is started, which means holding the turn. That's the opposite of what users feel — Option A's defaults preserve the turn and let TTS start immediately; B.2 would make affected turns *slower*.
- Text mode could afford this; voice mode probably can't.

### B.3 — Splitting the artifact into two tool calls (not recommended)

Core artifact (structural) and calibration artifact (tone/skill/ritual) as separate `@tool` decorators. Forces Haiku to emit each independently.

**Compromise:** Violates CLAUDE.md hard constraint #4 ("emit_artifact is required on every companion turn") by changing the number of calls required. Not viable without a spec amendment. Also doubles tool-use token overhead.

### B.4 — Ship with Option A defaults, monitor Haiku emission rate, escalate to Anthropic

Keep Option A (already shipped). Add telemetry logging for every occurrence of `ARTIFACT_CALIBRATION_DEFAULTED` with the model version, prompt tokens, response tokens, and which fields were dropped. Gather 100+ instances. File a targeted report to Anthropic with reproduction examples.

**Compromise:** We accept that ~10–50 % of long turns produce artifacts with neutral calibration values until either:
- Anthropic fixes the model-side behavior in a Haiku update, or
- We switch to Sonnet for companion turns (already used for builder; cost/latency implications).

**Cost:** Zero code. Already have the logs we need.

---

## Recommendation

Do all of: **B.1 + B.4**, and deliberately *not* B.2 or B.3.

- **B.1** hardens the schema so we rule out Pydantic translation as the cause.
- **B.4** accepts the limitation and records data to either prove or disprove that Haiku is the problem. If we see calibration-default rates drop after a Haiku model version change, we can retire Option A's defaulting logic.
- **Option A stays shipped**, because even a perfect schema cannot guarantee model compliance across all token-pressure conditions.

Do not do:
- **B.2** — punishes the user for the model's shortcoming by adding per-turn latency.
- **B.3** — violates the artifact contract without a spec amendment.

---

## Why this matters for GEPA

Option A's defaults (`active_tone_band="engagement"`, `skill_loaded="active_listening"`, etc.) flow into the turn trace (`users/{user_id}/traces/{session_id}.json`). A turn that defaulted is not a clean signal for tone optimization — the band was inferred from a neutral, not observed. GEPA must exclude defaulted turns from tone_delta calculations.

Recommendation: add `artifact_defaulted_fields: list[str]` to the trace schema. GEPA's golden-turn selector filters out any trace where `len(artifact_defaulted_fields) > 0` when computing tone regression. This is a small schema extension (`docs/specs/04_backend_integration.md` trace schema, ~3 lines of JSON).

If you approve, I will:
1. Implement B.1 (explicit JSON schema declaration for `emit_artifact`).
2. Add the `artifact_defaulted_fields` trace field plumbing from voice adapter → gateway → trace writer.
3. Update GEPA exclusion logic.
4. Add a weekly log aggregator that reports the calibration-default rate by model version.

That gives us clean data by the next GEPA window without blocking voice turns.

---

## One honest note about CLAUDE.md hard constraint #4

The line "Anthropic guarantees valid JSON on tool calls" in CLAUDE.md is correct *only* about JSON syntax, not about schema completeness. It has been working as an unstated assumption that required fields are also always populated. The production evidence disproves that. We should update that line in CLAUDE.md to read something like:

> "emit_artifact is required on every companion turn, via tool_use. Anthropic guarantees tool calls are *syntactically valid JSON* but does not guarantee *schema completeness* — the voice adapter must fill safe defaults for calibration fields when they are omitted."

This is a documentation-only change but avoids future engineers making the same assumption.
