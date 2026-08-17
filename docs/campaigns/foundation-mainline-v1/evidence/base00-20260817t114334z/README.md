# BASE-00 Evidence

This directory is the sanitized FC-01A receipt for experiment
`base00-20260817t114334z`. It records immutable source identities, public
application receipts, metadata-only provider observations, migration-file
digests, deterministic test classifications, review/privacy inventory, a draft
acceptance budget, and the blocked M00 proposal.

No raw trace, provider payload, user content, stable account identifier,
credential, signed URL, database coordinate, or local-user path is included.
Fields that could not be established without authenticated control-plane access
are explicitly `UNKNOWN`.

Run the offline evaluator from the campaign root:

```text
python3 evaluate_foundation_campaign.py evidence/base00-20260817t114334z
```

The checksum list covers every regular file in this directory except the
checksum list itself. The mutable campaign state records the evidence payload
commit after the first evidence-only commit, avoiding a false self-referential
commit identity.
