# codex-054 — Recap refresh and proposed-memory quality

Read-only investigation; no production fix or memory decision by Codex.
Session `fa978e7d-e46f-4000-9e95-9b865a00d2fd`; frontend `e4d55b31`, gateway `eb849b62`.
Confirmed: canonical recap fetched HTTP 200 at 21:41:03.824Z, before extraction committed at 21:41:05.758Z (all times 2026-10-03 UTC).
Run `7b33e682-728d-4cd2-a943-9b419ed33a47` succeeded once, produced 4, covered 62/62, source/input valid.
Current canonical envelope was complete; the UI remained processing. One read-only Retry restored the review UI.
Cause: useRecapArtifactsLoader canonical branch returns without scheduling polling; retry timers only serve legacy/404 paths.
Processing falsely displays load-failure copy; debug export silently requires ready, despite being visible while processing.
Davide then reported that visible memory proposals were verbose and unrelated to his intended conversation.
Candidate text equality matched this session's canonical candidates; no cross-session substitution found. All candidate sources are this session.
Each candidate cites all 62 turns (37 user, 25 assistant), not a specific evidential span.
Visible proposals were 32–35 words; extractor permits single-session preferences/patterns and validates structure, not claim support or usefulness.
The stock heading is labeled key takeaway even though canonical hydration supplies no actual takeaway.
During live user review, pending/rejected changed 4/0→3/1→2/2; approved 0. Codex did not operate decision controls.
Propose bounded canonical GET polling, honest processing/empty copy, sanitized debug access in failure states, and a neutral heading without a verified takeaway.
Separate quality fix: concise atomic durable claims, exact user evidence, suppress task logistics/assistant assertions, allow zero output, preserve governed input binding.
No tests/model evaluations run; add canonical transition and synthetic extraction quality regressions in follow-up PRs.
LangSmith's existing 3h views showed no runs; no waterfall evidence available.
Detailed report: `ops/mailbox/voice-next-20260924/codex-artifacts/sophia-recap-refresh-and-memory-quality-analysis-2026-10-04.md`.
