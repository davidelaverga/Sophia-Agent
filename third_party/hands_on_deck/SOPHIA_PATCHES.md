# Sophia patches to hands-on-deck

The vendored source is pinned to upstream commit
`1e94c3aa6bbe810708406ede1c248ebfd651bb2a`.

D2.1.1 adds only the following integration behavior:

- source identity extraction from `data-deck-*` attributes;
- duplicate source-ID rejection per slide;
- deterministic source-derived shape names and a source-map sidecar;
- `name` support for `add-picture`;
- stable machine-readable lint residue kinds.

These patches must not change layout measurement, typography, geometry,
atomic patch validation, rendering, or diff behavior. Regression coverage lives
in `backend/tests/test_hands_on_deck_sophia_patches.py`.
