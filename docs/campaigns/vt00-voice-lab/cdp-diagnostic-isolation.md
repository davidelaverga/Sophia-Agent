# Voice Lab CDP diagnostic isolation

Status: `CLOSED DEPLOYMENT GREEN — 66cebaa414b2a8b89f2881b34baaac22870652f5`

Falsifiable hypothesis: the Voice Lab browser driver contains no Chrome DevTools
Protocol or React-internal probe that can inspect, pause, resume, or otherwise
share the ordinary product page's execution path. This applies even when a
probe was previously guarded by a constant set to false.

The driver no longer creates CDP sessions, enables Runtime or Debugger domains,
preloads Next.js chunks, discovers passive-effect internals, installs
breakpoints, pauses on exceptions, evaluates React frames, or records effect
probes. All supporting classifiers, timers, correlation buffers, constants,
and tests were removed. Bounded Playwright `pageerror` observations and safe
same-origin console coordinates remain passive and do not issue renderer
commands.

A source-level negative contract rejects CDP session creation, Runtime/Debugger
commands, passive-effect discovery, probe fields, and former enablement flags.
Focused real-browser and driver contracts plus the full Voice Lab suite must
pass before publication. Production stays closed until exact-candidate
deployment again proves all six identities, one settled worker, zero active
runs, and all mutation and execution gates closed.
