# C2 recap rollback boundary

Parent: 6e06a627e9a997fc42a65f14120af358100495b6.
Scope: exact local recap reads/writes/cleanup and source invalidation before
session deletion. No production deployment, schema, flags or provider effects.

EI923/bd1074 exposed a runtime rollback defect after named owner fixtures were
repaired: removing the cohort disabled recap fencing because the code tested
candidate production availability. Canonical management remains durably owned
after flags-off/cohort removal. These paths now use that resolved canonical
management signal, not candidate-write availability. Unknown owner authority
still denies; positively declared legacy fixtures preserve their existing lane.

The full recap fixture runs with extraction enabled, disabled, and cohort removed.
It covers source deletion/revision/owner races, exact file cleanup, truthful local
receipts, offline writer fences and source invalidation. 9f521a:139 focused tests
passed. 3da892:1201 MEM00 tests passed in the larger working tree (not an isolated
release or hosted acceptance claim).

EI924/9bc2fe affected legacy session/offline tests:29 failed/160 passed because
their DB mocks omitted explicit durable legacy owners. Their existing fixtures
now declare only the named owners they exercise; unknown owners remain denied.
No global authority bypass. This slice does not enable extraction or recall,
prove hosted model admission, or certify complete account/provider erasure.
