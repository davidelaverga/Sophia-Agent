# C2 frontend source/chat candidate — not deployed

Parent d3dfc4d57858c90af7c44c024b0362fdaee0951b.

Selected existing browser source-input/outbox and Next chat boundary integration.
The current authenticated owner must match source profile/body scope. Original
source identities/epoch survive explicit retries; a fresh observation cannot
rewrite the old action. Unknown authority denies sends, not inferred legacy.
Governed input cannot use legacy attachment/spill/mock/reseed fallbacks.
Completion requires the exact original run's terminal success, not stream EOF.
Responses are no-store; owner/thread generations invalidate stale callbacks.

Working-tree88cc4f:376 chat/session tests passed. Three conditional installed
HTTP cases were skipped because MEM00_HTTP_RUN_CASES was absent; they are not
counted as passing. ce7804:27 source-hook/route tests passed. EI926–927 were route
fixtures missing source profile/authenticated body scope; fixtures now declare
explicit synthetic legacy owner and wait for the current observation. Runtime
checks were not relaxed. React act warnings remain in unrelated synchronous
route assertions when the new profile effect resolves.

Isolated staged frontend archive f15e79 also passed376/3 skipped; dependencies
reuse the pinned node_modules only, source/tests resolve in the archive. EI928/
e150cd typecheck failed because the frontend-only archive omitted root testdata;
adding the same tree's tracked fixture made TypeScript56ef5d pass. No code change
was needed. Working-tree typecheck4df79b also passed. This evidence paragraph is
the only change after the isolated run.

This commit does not activate an account, change Mem0, replace canonical memory
authority, prove hosted recall, or qualify every ordinary Builder operation.
The real production journey and compatible shared deployment remain required.
