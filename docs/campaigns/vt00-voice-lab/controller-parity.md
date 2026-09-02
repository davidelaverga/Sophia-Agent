# Voice Lab controller parity

Status: `CLOSED DEPLOYMENT GREEN — ad611e382ecd96a2ab1b7a5041b187f7d9f39aed`

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
remained green before publication. The exact candidate was deployed on all six
components and the aggregate readiness attestation reported one settled worker,
zero active runs, exact component identities, and every mutation gate closed.
