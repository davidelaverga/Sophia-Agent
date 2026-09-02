# Voice Lab UI fallback isolation

Status: `CLOSED DEPLOYMENT GREEN — b973a2af742f36dbf148b7bd2f395d5b3bd32bb6`

Falsifiable hypothesis: production Voice Lab startup has exactly one activation
path: the server-authorized, default-disabled control adapter. The worker must
not retain callable helpers that discover or activate dashboard microphone
buttons, select a voice tab, click consent or fresh-session controls, or reload
dashboard/session routes after a client error or empty shell.

The obsolete dashboard microphone, session navigation, voice-tab selection,
consent routing, client-error polling, and route-reload helpers have been
removed together with their tests and recovery-only constants. Empty-route
recovery classifiers and recoverable-page label constants were also removed.
The remaining startup sequence is the exact grant, control-adapter session-start
receipt, same-origin `/session` commit, control-adapter voice-start receipt, and
product/provider readiness attestation.

Focused contract and real-browser tests must pass with generated init-script
negative assertions, followed by the full Voice Lab suite. Production remains
closed until the exact candidate is deployed to all six components and aggregate
readiness proves exact identities, one settled worker, zero active runs, and all
mutation and execution gates closed.
