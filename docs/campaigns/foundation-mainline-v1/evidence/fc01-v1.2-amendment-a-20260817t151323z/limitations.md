# Limitations and Non-Claims

- Amendment A has no Davide or Luis decision. Its immutable payload status is
  `AMENDMENT_DRAFT_PENDING_SEAL`; only a valid additive seal may set the
  campaign to `AMENDMENT_READY_FOR_JOINT_APPROVAL`, never `AMENDMENT_APPROVED`.
- No FC-01A-R branch was created and no repair or test in the new lane was run.
- No product code, test, fixture, workflow, migration, provider, database,
  secret, budget, deployment, or production state was changed.
- The current `base00-draft-1` remains `DRAFT_UNSIGNED`; its spend, identity,
  and maintenance window are not reused or silently approved.
- All provider/deployment/database observations are inherited from the latest
  checksum-bound read-only receipts. They must be revalidated at the exact
  repair candidate before any new BASE-00 or target-specific request.
- Gateway and LangGraph future candidate deployment IDs do not exist. Current
  `9ee901f...` deployments are only proposed immediate rollback anchors for a
  later separately approved candidate.
- Vercel remains observe-only only after the complete production-input closure
  and provider-settings digest—not merely the frontend subtree—are proven
  byte-identical. That closure is not yet computed. Mandatory frontend test
  edits are conservatively treated as build inputs; a pinned hermetic build is
  now an M00 prerequisite and currently has a known remote-font failure. A-R
  authorizes no frontend product repair for that failure. If the closure
  differs and the proof passes, Vercel may participate only under the bounded
  candidate budget and separate Davide plus Luis target decisions.
- Voice is excluded only under a jointly approved text-only scope with a
  zero-Voice-origin receipt and a Gateway auth preflight proving
  `SOPHIA_AUTH_BACKEND_URL` selects Vercel Better Auth rather than Voice or
  localhost fallback. Its deployed source remains divergent and rollback
  remains unproved.
- The eight required M00 route edges, Vercel Better Auth database equality,
  shared Builder-event HMAC presence/equality, and post-candidate rollback
  selectability remain unproved.
- Exact historical applied migration bytes and checksums remain unproved. The
  amendment permits temporal deferral only after a complete current M00
  relation/routine/ACL/RLS/storage fingerprint passes; it does not name a
  historical variant canonical.
- Gateway database-project equality, the DQ shadow catalog, ACL/RLS posture,
  and critical advisor mapping remain unproved. No database repair is
  authorized.
- The confidential object inventory is source-expected state, not a claim
  about live state.
- Ten secret-history records representing three strings remain unresolved.
  No raw value was copied, validated against a service, suppressed, rotated,
  or revoked.
- Provenance for 165 tracked records remains unproved. Fifteen are known
  Render-image reachable. Reachability of the other 150 through Vercel's
  outside-root source bundle and production-runtime closure is unproved, so
  both groups are M00 prerequisites. No record is called repository-only until
  exact provider upload and A-G closure evidence proves it. Any confirmed real
  secret/PII is a global P0 stop.
- Seventy-one M00-critical logical tests remain `NOT_RUN`; 20 logical tests
  (19 generic live-client plus one Node HTML-report-to-PDF smoke) remain
  post-M00 gates. The old 91 aggregate is decomposed, not called pass.
- The clean campaign baseline remains red. Post-M00 failures remain explicitly
  failed; this amendment does not call the repository or release green.
- PR #144 remains conflicting, review-thread state is unchanged, and main
  remains unprotected. Those later convergence controls are not repaired here.
- Five predecessor image/build/retention unknowns are resolved nullable under
  the field-specific authenticated non-exposure contract and are no longer
  blockers. Failed or omitted future collection is still blocking.
- LangGraph live checkpointer identity and durable resume are not proved. M00
  may make no restart/durability claim and must abort on restart/disconnect;
  M01 retains the substantive gate.
- The main evaluator validates structure, checksums, Git seal objects, privacy
  patterns, exact IDs/counts, and decision bindings. The approval evaluator
  additionally performs read-only GitHub issue-comment identity checks through
  `gh api`; unavailable or unverifiable identity evidence is blocking. Neither
  evaluator can judge prose quality, prove live state, create human decisions,
  or authorize any unlisted action.
