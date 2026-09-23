# C086–C088 backend CI disposition

All seven backend failures are now reproduced at the actual PR151 base3754c3022bcfc2be1e3b8d097040b7d81ad23ac6 and headd467ab97 on the SAME Linux runner with identical assertions. Diagnostic run35916904466/job107370625089 used exact checkouts, Python3.12.14, uv setup, unchanged lockfile and natural runner clock. Setup succeeded for both; the diagnostic correctly finished red. Machine-checked14failure lines split into identical groups of seven: evidence/2026-09-23-c087-ci-reconciliation.json. Five memory failures are young-boot expiry handling (issue152); two deck failures are Linux layout behavior, exact layout cause unproven (issue153). Both issues are normal maintainer tracking, not waivers. No introduced failure found in this set; no source/test/check changes, force-merge or ordinary-product redeploy. PR151 remains open; failed CI remains failed. Independent Lab/architecture/memory-E2E qualification is unchanged.

- https://github.com/davidelaverga/Sophia-Agent/actions/runs/35916904466/job/107370625089
- https://github.com/davidelaverga/Sophia-Agent/issues/152
- https://github.com/davidelaverga/Sophia-Agent/issues/153

No documented inherited-failure waiver process was found; the upstream CONTRIBUTING Issues link is not approval for this fork. Maintainers retain merge/check decisions. Internal-use evidence is assessed separately from repository merge readiness.
