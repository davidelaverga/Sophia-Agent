# Sophia Builder — Presentation-Deck Failure Forensics (2026-06-27)

**Investigated:** 2026-06-27 ~04:15 UTC · **Author:** Claude (Sophia agent loop)
**Method:** Render logs (sophia-langgraph + sophia-gateway), deployed-vs-HEAD `git` cross-reference, adversarial multi-agent verification. LangSmith traces were **unavailable** (prod ingest is failing 4xx — see §7); every finding below is reconstructed from Render logs + source.
**Companion thread:** `019f0665` · **User:** `CUyZxRFmDNON` · **Builder model:** `claude-sonnet-4-6`
**Predecessor report:** [`sophia-builder-deck-failure-and-pdf-render-forensics-2026-06-26.md`](./sophia-builder-deck-failure-and-pdf-render-forensics-2026-06-26.md)

---

## Status at a glance

| Build | Run (task_id) | Dispatched | Outcome |
|---|---|---|---|
| **Deck #1** (8-slide, "self-improving harnesses") | `019f0668` | 00:09:14Z | ❌ **Hard-ceiling timeout** turn 45 (00:24:20Z) · `status=timeout` · `artifact_path=None` |
| **Deck #2** (8-slide, same brief) | `019f0679` | 00:27:42Z | ❌ **Silent hang** inside image-gen subprocess · no langgraph terminal · gateway watchdog closed it `status=timeout` 00:39:55Z |
| PDF report (control) | `019f06a0` | 01:09:49Z | ✅ **success** (01:15:31Z) · `render_html_to_pdf`, 8 pages |
| Markdown (control) | `019f06d5` | 02:08:02Z | ✅ **success** (02:13:35Z) |

**One-line verdict:** The deck pipeline on the **live deploy is internally self-contradictory** — it commands the model down the *retired* "full-slide bitmap + slide-plan JSON + `ppt-generation/scripts/generate.py` compiler" path, then **blocks** that path, with no coherent route to the new `build_deck_from_slides` flow. The model never authors a single `slides/*.html`, never calls `build_deck_from_slides`, never produces a `.pptx` → it loops to the hard ceiling (deck #1) or wedges inside a hung image-gen subprocess (deck #2). **PDF/markdown succeed because their paths are coherent.**

> ⚠️ **The most important finding: a redeploy alone will NOT fully fix this.** The single most damaging steering string — the turn-3 correction `_pptx_skill_correction_message` — is **byte-identical old-flow in current HEAD `c1aa8dc7`**, not just in the deployed commit. It (and ~6 sibling middleware/skill strings) need explicit code rewrites. See §5.

---

## Deploy context — prod is 6 commits behind, AND HEAD is still partly broken

Both backends are live at **`eabe6058`** ("Fix slide renderer viewport context", deployed 2026-06-27 **00:01–00:04 UTC**) — the parent-of-parent of current HEAD:

```
c1aa8dc7  fix(builder): fail deck slide render on missing local image assets   ← local/origin HEAD (UNDEPLOYED)
ebf94d7a  Fix visual diagnostics and PPTX preview selection                    ← UNDEPLOYED
c6e5a520  Fix PDF-target builder tools and HTML asset validation               ← UNDEPLOYED
67dd74fe  Align image generation skill with artifact paths                     ← UNDEPLOYED
4781bdf3  Align PPTX prompt contracts with HTML slides                         ← UNDEPLOYED  (fixes builder_obligations.md)
8b495554  Clear tolerated PDF page warnings                                    ← UNDEPLOYED
c0c47cfa  deck compile latch instructs build_deck_from_slides ...              ← UNDEPLOYED  (fixes the bash-force latch)
──────────  (deploy boundary)  ──────────────────────────────────────────────
eabe6058  Fix slide renderer viewport context                                 ← LIVE on sophia-langgraph + sophia-gateway
```

Two consequences:
1. The **always-injected skill files** (`builder_obligations.md`, `visual_composition.md`) are stale old-flow on the live deploy — fixed in HEAD by `4781bdf3`, so a redeploy *does* help.
2. **But** the load-bearing **turn-3 middleware correction** `_pptx_skill_correction_message` and several sibling strings are old-flow in **both** `eabe6058` **and** `c1aa8dc7`. The Phase-0 "HTML slides" migration (`6c24087c`, `4781bdf3`, `c0c47cfa`) **missed them.**

---

## Root cause

### RC-1 (PRIMARY, both runs) — the deck pipeline contradicts itself: a 3-way deadlock

Phase 0 (commit `6c24087c`) introduced the correct deck contract — *author one self-contained 1920×1080 `slides/*.html` per slide, then call `build_deck_from_slides` once; the harness renders each slide to a PNG and wraps to `.pptx`; the model never runs a compiler.* The deck **tool**, the **`ppt-generation/SKILL.md`**, and the **builder system prompt** (`builder_task.py` `pptx_visual_guidance`) were all correctly updated.

**But three deck control-flow surfaces still drive the *retired* flow, and they mutually deadlock:**

1. **Turn-3 correction → "run the old compiler."** When a presentation build has no `.pptx` yet and has drifted ≥3 turns, `_maybe_inject_pptx_skill_correction` injects `_pptx_skill_correction_message` ([builder_artifact.py:4745](../../backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py)). It commands, verbatim:
   > *"Generate one full-slide PNG per slide… Create a valid slide plan JSON under `/mnt/user-data/workspace/`; each slide must point to its PNG with `image_path`… Run the PPTX compiler through the ppt-generation workflow with `/mnt/skills/public/ppt-generation/scripts/generate.py`, `--plan-file`, and `--output-file`."*

   This fired in **both** deck runs — log `BuilderArtifact: presentation target needs ppt-generation correction turn=3` at **00:09:34** (run #1) and **00:28:01** (run #2). It actively pulls a model that already read the *correct* SKILL.md back onto the dead path.

2. **The improvisation backstop → blocks that exact command.** `_deck_improvisation_rejection` (deployed, wired at builder_artifact.py:9314/9821) rejects any tool call carrying `ppt-generation/scripts/generate.py` / `python-pptx` / `pptxgenjs` / `Presentation(` for a `.pptx` target. Run #1 turn 5 the model **obeyed the correction and ran `generate.py`** (`[BuilderSkill] script_invoked: skill=ppt-generation`) → was immediately rejected: `[BuilderDeck] phase=improvisation_blocked tool=bash` at **00:09:46**.

3. **The recovery latch → forces `bash` toward the blocked compiler.** `_pptx_compile_tool_choice_for_state` (deployed, builder_artifact.py:7634) forces `tool_choice=bash` ("…runs the existing PPTX compiler path with the existing plan JSON") once slide images are ready — i.e. the harness's own rescue path points at the very compiler the backstop forbids. (It happened not to *arm* here because it needs 8 image successes and only 1 succeeded — but it is wired to the wrong target.)

**The model can satisfy none of these simultaneously and is never steered to the one coherent action** (`slides/*.html` → `build_deck_from_slides`). Result, in **both** runs: **0 `build_deck_from_slides` calls, 0 `slides/*.html` authored, 0 `.pptx` written.** Run #1 instead wrote 17 `.json` + 2 `.py` + 3 `.txt` files — **all to workspace** (`path_under_outputs=False`), i.e. slide-plan JSON for the dead compiler.

Reinforcing this on the live deploy only: the always-injected **`builder_obligations.md` Presentation Rules** ("*Presentations are pure image-forward. Generate one full-slide image per slide… The PPTX compiler adds only that bitmap plus speaker notes*") and **`visual_composition.md`** Presentation Invariants. These are **fixed in HEAD** (`4781bdf3`) — a redeploy removes them — but the three deadlock surfaces above are **not** fixed by the redeploy (see §5).

### RC-2 (deck #2's distinct terminal state) — image-gen subprocess hangs with no escape

Run #2 took the same wrong path, then at **turn 7 (00:28:23.62Z)** invoked the image-generation bash subprocess (`script_invoked: skill=image-generation`) and **went permanently silent** — no `BuilderImageGeneration` result, no further LLM call, no hard-ceiling, no completion webhook. The gateway polled the run as `running` at ~60 s cadence until its **own ~11.5-minute watchdog** synthesized `status=timeout` at **00:39:55Z**.

Why no escape: the image-gen **OpenAI client** timeout *is* deployed (`OpenAI(timeout=SOPHIA_IMAGE_GEN_TIMEOUT, max_retries=0)`, default 600 s — from `8865413c`, an ancestor of `eabe6058`), **but it bounds the HTTP call, not the subprocess.** The deployed sandbox `bash` tool has **no wall-clock timeout** (none in `sandbox/tools.py@eabe6058`). So when the image-gen subprocess stalls below the client-timeout granularity, the builder's `await` on the bash tool never returns, the turn loop never advances, and the 45-turn hard ceiling (which *did* save run #1) never runs. **This is not fixed by any of the 8 undeployed commits** — it is an open infra gap in both `eabe6058` and HEAD.

### RC-3 (contributing) — image generation yield is poor

Even before any hang, run #1 produced **1 successful image out of 8 slides** (`phase=call_blocked attempts=15 in_command=1 successes=1`, 00:16:38; `image_cost=$1.05`, est run cost ~$3.04). On a coherent pipeline a deck still cannot render 8 slides if 7 images fail. This is separate from the steering bug and should be audited (OpenAI key/quota on sophia-langgraph; the hero-anchor `--manifest` batch path). Note: HEAD's `c1aa8dc7` missing-asset guard will correctly **fail** such decks rather than ship broken ones — so low yield will surface as honest deck failures until reliability improves.

### Why the controls passed
PDF and markdown have **coherent, deterministic** paths with **no image-gen subprocess** and **no pptx skill-correction**:
- **PDF `019f06a0`:** write HTML (under `outputs/`) → forced `render_html_to_pdf` → page-count repair (never terminal) → forced `emit_builder_artifact`. `image_calls=0`. Success in 5m42s.
- **Markdown `019f06d5`:** plain `write_file` under `outputs/` (chunked) + one inline `.svg` → `emit`. `image_calls=0`. Success in 5m33s.

---

## §5 — Residual old-flow steering that survives a redeploy (must be fixed in code)

The Phase-0 migration fixed the skill files and the system prompt but left **several middleware messages** pointing at the retired flow. These are present in **current HEAD `c1aa8dc7`** and will keep breaking decks even after a redeploy. (`file:line` are HEAD.)

| # | Location | Problem | Live? |
|---|---|---|---|
| **S1** | `builder_artifact.py:4745` `_pptx_skill_correction_message` | **The decisive one.** Turn-3 correction commanding full-slide PNG + slide-plan JSON + `generate.py --plan-file`. Fired in both failed runs. | ✅ fires |
| S2 | `builder_artifact.py:4791` `_pptx_plan_correction_message` | "Do not switch to HTML" + plan-JSON + per-slide `image_path`. Gated on a diagnostic the HTML flow never sets (latent trap). | gated-off |
| S3 | `builder_artifact.py:4849` `_visual_design_skill_message` | "For PPTX decks, every slide must be a generated full-slide image embedded by the PPTX compiler." Fires on any visuals-requested deck turn. | ✅ can fire |
| S4 | `builder_artifact.py:8430` `_maybe_inject_image_generation_stop` (inline) | "A Sophia PPTX requires one generated full-slide image per slide…" Fires after 2+ image-gen failures. | ✅ can fire |
| S5 | `builder_artifact.py:6982` `_deck_plan_rejection_message` | "re-run the PPTX compiler … embedded full-slide picture." Gated on old plan diagnostics (effectively dead). | gated-off |
| S6 | `builder_artifact.py:4866` `_visual_asset_required_message` | "For PPTX, generate full-slide images and reference them with `image_path`." **Dead code** (no call site) but residual text. | dead |
| S7 | `builder_artifact.py:7085` visual-evidence rejection parenthetical | "presentation image-forward slide visual" menu item. Minor. | ✅ can fire |
| S8 | `image-generation/SKILL.md:52` `--slide-visual`; `ppt-generation/scripts/generate.py` (old `--plan-file` compiler); `slide_qc.py` | Retired artifacts still on disk/advertised — a drifting model can rediscover the full-slide compiler path. | on disk |

**Already fixed in HEAD (so a redeploy resolves these):** `builder_obligations.md` Presentation Rules, `visual_composition.md` Presentation Invariants, `builder_task.py:639` docstring. **Correct in both deployed and HEAD:** `ppt-generation/SKILL.md`, `builder_task.py` `pptx_visual_guidance` + completion bullets, `_pptx_compile_latch_message` (HTML flow, but only fires after image successes), `_deck_improvisation_rejection`.

---

## §6 — Recommended fixes, prioritized

**P0 — Redeploy AND fix the residual steering (both are required).**
1. **Redeploy `sophia-langgraph` + `sophia-gateway` together to HEAD `c1aa8dc7`.** Removes the stale `builder_obligations.md`/`visual_composition.md`, flips the compile latch to `build_deck_from_slides`, adds the missing-asset guard. *Necessary but not sufficient.*
2. **Rewrite `_pptx_skill_correction_message` (S1) to the HTML-slide / `build_deck_from_slides` contract** — this is the load-bearing fix; it's the message that actually reached the model at turn 3 in both failures and it's old-flow even in HEAD. Then sweep S2–S7 (rewrite or delete) and add **a single invariant**: *no deck instruction surface may reference `generate.py` / `--plan-file` / `python-pptx` / "full-slide image per slide" / a "PPTX compiler".*
3. **Repoint the deck force-gate** (`_pptx_compile_tool_choice_for_state`) to force `build_deck_from_slides` (gated on `slides/*.html` present), never `bash`. (`c0c47cfa`/`ef6914ee` do this — verify after merge.)

**P1 — Close the silent-hang and yield gaps.**
4. **Add a wall-clock kill on the image-gen bash tool** (harness/sandbox level), so a stuck `generate.py` fails the turn (raising a timeout error class that still fires the force-emit + completion webhook) instead of wedging the whole run with no terminal event. The OpenAI-client timeout is not enough — the gap is at the subprocess/tool layer. Fixes RC-2.
5. **Audit image-gen success rate** (1/8 in run #1): OpenAI key/quota on sophia-langgraph, the hero-anchor `--manifest` batch path.

**P2 — Guardrails.**
6. **Regression / staging smoke test:** a real `.pptx` build must call `build_deck_from_slides` exactly once and author ≥1 `slides/*.html`; assert no `tool_choice=bash` deck-compile warning and no `generate.py` invocation. Both runs showed 0 deck-tool calls with no runtime gate catching it.
7. **Retire on-disk old-flow surfaces** (S8): drop `--slide-visual` from `image-generation/SKILL.md`, quarantine `ppt-generation/scripts/generate.py` + `slide_qc.py`.

---

## §7 — What is NOT broken / not the cause

- **Not an infra outage.** Every Anthropic `/v1/messages` call in the deck window returned 200. No rate-limit (429/529), recursion-limit, or auth errors. The token blow-up (run #1 input grew 14k → **1.91M** by turn 45) and the 1/8 image yield are **symptoms** of the no-coherent-path loop, not independent causes.
- **`build_deck_from_slides` is registered and callable** on the live deploy (`builder_tools.py:49`). The model was simply never instructed/forced to call it and was actively steered elsewhere.
- **The PDF HTML→PDF path works well in prod** (control run succeeded cleanly) — the 2026-06-25/06-26 PDF fixes are effective.
- **LangSmith tracing is mis-configured in prod** (ingest `Failed to send compressed multipart ingest … 4xx`). It did not affect the builds, but it's why deep trace-level evidence was unavailable; all conclusions here are from Render logs + source. Worth fixing so the next forensics is a trace query, not log-scraping.

---

## Appendix A — Run timelines (from Render logs)

**Deck #1 `019f0668` — steering-deadlock loop → hard-ceiling timeout (15m06s)**
```
00:09:14.26  start_builder_task launched  task_type=presentation (8-slide)
00:09:21.30  turn 1: read_file,read_file,write_todos        in=13,948
00:09:21.38  forcing tool_choice=builder_web_search
00:09:34.54  ⚠ "presentation target needs ppt-generation correction turn=3"  → injects _pptx_skill_correction_message (OLD flow)
00:09:46     [BuilderDeck] phase=improvisation_blocked tool=bash   (model ran generate.py; backstop blocked it)
00:09:59+    turn 6+: write_file path_under_outputs=False ext=json  (slide-plan JSON to workspace, repeats every turn)
00:12:09.19  ONLY successful image: gpt-image-2 png 1.52MB
00:14:57.64  soft ceiling warning turn=27
00:16:38.18  image-gen phase=call_blocked attempts=15 in_command=1 successes=1   (8 requested)
   in= growth: 13,948 → 205k (t9) → 497k (t18) → ~841k (t27) → 1,911,299 (t45)
00:24:09.79  forcing write_file before emit (no output file yet); late writes ext=py,txt (workspace)
00:24:20.35  ❌ hard ceiling turn=45 → forced end → fire_completion_webhook status=timeout artifact_path=None
```

**Deck #2 `019f0679` — same wrong path, then silent subprocess hang**
```
00:27:42.24  start_builder_task launched  task_type=presentation (8-slide)
00:27:51.65  forcing tool_choice=builder_web_search
00:28:01.83  ⚠ same "ppt-generation correction turn=3"  → _pptx_skill_correction_message (OLD flow)
00:28:20.47  turn 6: write_file path_under_outputs=False ext=json (slide-plan JSON)   in=130,233
00:28:23.54  turn 7: tools=bash → script_invoked: skill=image-generation (gpt-image-2)
00:28:23.62  LAST langgraph activity (final progress POST). Total silence afterward.
  [gateway]  run-status polls GET .../runs/019f0679 every ~60s 00:33→00:48 (still "running")
00:39:55.18  ❌ gateway watchdog: builder_events status=timeout → builder_completion + companion_wakeup
```

**Controls:** PDF `019f06a0` write-HTML→force `render_html_to_pdf` (page_count 1→8, layout ok)→force `emit` → ✅ 01:15:31, `image_calls=0`. Markdown `019f06d5` chunked `write_file` md + inline svg → ✅ 02:13:35, `image_calls=0`.

## Appendix B — Evidence & access
- Saved logs: `docs/audits/_logs_2026-06-27/langgraph_clean.jsonl` (4,156 unique rows, 00:01–03:00Z), `gateway_deckwindow.jsonl`.
- Render: `sophia-langgraph` `srv-d7be5s9r0fns7397l4fg`, `sophia-gateway` `srv-d7be5s9r0fns7397l4g0`; both deploy `eabe6058` (live 00:01–00:04Z). CLI authed via `~/.render/cli.yaml`; `RENDER_API_KEY` in `~/.zshrc`.
- LangSmith: key unavailable locally; prod ingest 4xx-failing → no trace evidence.
- Cross-referenced commits: deployed `eabe6058` vs HEAD `c1aa8dc7` via `git show <sha>:<path>`.
