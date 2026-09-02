# Voice Lab controller parity

Status: `IMPLEMENTED — CLOSED DEPLOYMENT ASSERTION REQUIRED`

Falsifiable hypothesis: after exact server authorization, each Voice Lab
controller action invokes the same callback as the corresponding visible Sophia
control. The dashboard `session-start` action must invoke `handleCallSophia`, and
the session `voice-start` action must invoke `handleMicClick`. No synthetic-only
wrapper may bypass the visible control's current-state, ritual-selection,
read-only, scaffold, mute, reconnect, interruption, or barge-in behavior.

The adapter remains server-authorized and default-disabled. This repair changes
only the callback boundary after authorization; it adds no route, DOM, provider,
text, storage, or browser-control fallback. A source-level contract fails if
either private wrapper returns or either adapter stops using the exact visible
control callback. Existing route, hook, session, dashboard, and Voice Lab suites
must remain green before publication, followed by a closed exact-candidate
deployment assertion with one settled worker and zero active runs.
