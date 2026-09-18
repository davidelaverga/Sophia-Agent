# C2 existing memory regression fixtures

Parent21808968332f6e8de7b0cafe3f900df22a9cd62c. Test-only correction;
no runtime authority bypass, deployment, provider effect or hosted acceptance.

- Named durable owner declarations replace flag-only assumptions; unknown owners
  remain unavailable and the legacy logging test explicitly declares its legacy owner.
- Extraction faults are injected after capturing the original authenticated
  dispatch inputs/context/reference. The constructor stub accepts the pinned
  no-retry argument. Production extractor still performs its actual checks.
- End uses the transactional current-source target, with exact message versions,
  recorded input references and matching clear epoch. Reused completed work and
  empty sessions do not queue another extraction. Revision conflict emits no success.
- Retained memory shutdown clears the retrieval proof as well as memory text/IDs.

Evidence: extractor/dispatch1a8fe3 passed57; End/source-targetf6e8b2 passed84;
rollback/governance/voice/recap9f521a passed139; full working-tree MEM003da892
passed1201. Earlier fixture failures and causal changes are recorded as EI918–923
in the campaign record. These are qualification fixtures, not production canaries.
