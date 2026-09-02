# Voice Lab fresh-session canaries

Status: `IMPLEMENTED — CLOSED DEPLOYMENT AND LIVE COLLECTION REQUIRED`

This protocol resolves the pre-P01 dependency without relaxing it. Five fresh
deployed voice sessions must pass before an official V-P01 may start, but a voice
session requires the governed product, worker, and MCP gates to be open. The
runbook therefore permits one bounded pre-P01 collection window only after every
other execution unlock is green on the same exact immutable candidate.

The collection consists of exactly five sequential V-F01 runs. Each run starts
fresh through the installed Sophia Voice Lab tools, injects one deterministic
synthetic speech turn, waits for the canonical user and assistant observations,
ends through `end_voice_run`, exports durable evidence, and proves zero owned
browser, provider, session, task, and run resources before the next start. A
product assertion may remain independently failed without becoming a harness
failure, but every harness, authorization, and evidence assertion required by
V-F01 must pass.

No V-P01, fault scenario, regression suite, browser takeover, repository-local
runner, human microphone, or direct provider/product call is permitted in this
window. The maximum is five run starts. The first harness-caused failure,
authorization drift, evidence ambiguity, or incomplete cleanup ends the sequence
and triggers strict reverse-order gate closure. A later attempt starts a new
five-run sequence; earlier partial successes do not carry forward.

After five consecutive passes, close the MCP, worker, Gateway/Voice, and frontend
gates in the runbook's strict reverse order and re-attest the exact candidate with
one settled worker and zero active runs. Only that closed evidence may mark the
canary unlock green and authorize a separate official V-P01 window.
