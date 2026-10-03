# claude-001 — epoch open: voice-next-20260924

Written 2026-09-23T23:33Z (2026-09-24 01:33 Europe/Rome). Author: Claude (coordinator). Immutable.

## Epoch and identities
- Epoch: `voice-next-20260924`, a child directory of the EXISTING mailbox root. Claude cannot see that root. Codex: if the directory already exists with a different ownership record, do not overwrite it. Use `voice-next-20260924-b` and say so in codex-status.
- Claude session: claude.ai/code cloud session `session_01HuyW8k26dfknko1kqu1WXW` (harness name `sophia-agent-3b`). Model checked with get_session: configured `claude-opus-5-5`, last served `claude-opus-5-5`.
- Claude's reach: an Anthropic cloud container with the GitHub repo only. It has NO access to Davide's Mac filesystem, the mailbox root, the operator evidence archive, Codex thread automations, Render, Vercel or the installed Voice Lab plugin. Claude reviews code through pushed GitHub branches. Davide relays mailbox messages.
- Codex session: unknown to Claude. Codex records its harness-provided identity in `codex-status.json`.
- Roles for this epoch only: Claude coordinates, reviews and gives verdicts. Codex is the sole implementation, deployment, test-window and scheduler operator. Claude performs no service, gate or browser mutation.

## Checkpoint inherited (re-read from GitHub 23:30Z; nothing newer found)
| Anchor | Ref | SHA |
|---|---|---|
| Qualified code / PR #151 head | `codex/vt00-c5-first-use-repair` | `d467ab97464908b4e7c7752701eee9d24db7faf6` |
| PR #151 base | `codex/mem00-c3-closure` | `3754c3022bcfc2be1e3b8d097040b7d81ad23ac6` |
| Published handover | `codex/vt00-c5-closeout-handover` | `880118f17e4400872aef3116999a46fb5e9bbd4f` |
| CI diagnostic (do not deploy) | `codex/vt00-c5-ci-comparison` | `58bc19448fc1ad63011fc9d123ac7400b6f63877` |
| main (not a deploy source here) | `main` | `b489ac0be4a3ee3d5acd69e2fd05ba20a1d5bbd7` |

- PR #151 is open and not merged (mergeable_state `unstable`, last updated 2026-09-23T20:42Z). Its 7 inherited failures are tracked in issues #152 (MEM00 young-boot expiry, 5 tests) and #153 (Linux deck layout, 2 tests). Both issues are open. These failures are not waived.
- C5 stays `VOICE_LAB_INTERNAL_USE_READY` under the approved bounded retention disposition. We are not re-certifying it.
- Qualified tuple recorded at 20:39Z: Frontend `083d4cb0` / `dpl_FVi7Dp1eVxKfM9UHzKZ8PdifzA1p`; Gateway `6f15f5e2`; Voice `f128af0c`; LangGraph `def5c454`; Lab MCP+worker `d467ab97` on schema 6; plugin `0.1.0+codex.20260913232552` with SHA256 `f799c321…8b4f0b`. J6 itself ran with Gateway `083d4cb0`.
- Services recorded at 20:39Z: MCP `srv-da6uiqfavr4c739mtbng` suspended with 0 instances. Worker `srv-da6uiqfavr4c739mtbo0` running 1 instance, `dep-dapvg80u01pc73e3o900`, kill switch true, admission closed.
- Retention obligations: J4 `6a05f180…` due 08:39:46.775Z; J5 `d356836c…` due 13:27:55.991Z; J6 `bb39a997…` due 14:20:06.803Z (all 2026-09-24). None of these deadlines changes.
- Old task: `finish-voice-lab-retention-and-suspend-worker`, a one-time Codex thread automation scheduled 2026-09-24 16:25 Europe/Rome (14:25Z). Its owner is the old Codex thread. Claude does not know its identity.
- Cost: cumulative $5 cap. Known estimates only: provider ≈ $0.350418 (delayed and rounded) and worker ≈ $0.25. Neither is an invoice.

## Authority and exclusions
- Authority: Davide's 24 Sep immediate-testing instruction (pack v2: 00/01/02/07). It covers the bounded test-and-repair loop, with these limits: ≤ 3 runs, 1 active run at a time, ≤ 2 utterances per run, ≤ 15 s per clip, ≤ 900 s per run, the existing synthetic principal, the installed authenticated plugin, and the ordinary app route. No raw-audio retention.
- Excluded: MEM00/#152 and deck/#153 repairs, Builder exercise, OAuth or client migration, direct Gemini calls used as app evidence, memory activation, new recurring services, changes to retention deadlines, and full VT00/endurance work.

## Evidence index (pointers only)
- Published: `docs/campaigns/vt00-voice-lab/c5-r1/{operator-handover,first-use-evidence-index,retention-closeout,current-state}.md` at `880118f1`.
- Operator-local (Codex reach only): `/Users/davidelaverga/Documents/Codex/2026-08-19/pl/work/Sophia-Agent-mem00-closure/docs/campaigns/vt00-voice-lab/c5-r1/evidence/`. Relevant files: `2026-09-23-j6-events-final.json` (1629 events), `2026-09-23-j6speak2.json` (op `6f2e6881-079d-45f5-b19a-624699855089`) and `2026-09-23-j6-operator-evidence.zip` (SHA256 `dfdd0fd5…`).
- Defect case: J6 turn 2 text `Let's just discuss calm. Please suggest one small way to feel calm.`, UTF-8 SHA256 `918af93b0f15d580a8075c7a4fdc71b578da3dac5ae853acce1db8c0e005c879`. The published record says this English audio was transcribed incompletely as French.
- Old-pair compact handoff (`03`): not available to Claude. If it exists, Codex reads it locally.
