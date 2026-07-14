# Sophia patches to hands-on-deck

The vendored source is pinned to upstream commit
`1e94c3aa6bbe810708406ede1c248ebfd651bb2a`.

D2.1.1 adds the following integration behavior:

- source identity extraction from `data-deck-*` attributes;
- duplicate source-ID rejection per slide;
- deterministic source-derived shape names and a source-map sidecar;
- `name` support for `add-picture`;
- stable machine-readable lint residue kinds.

The production-correctness patch set also changes text measurement and repair:

- PowerPoint point sizes are converted to 96-DPI pixels before Pillow measurement;
- bold and italic faces are resolved explicitly, with style-aware fallbacks;
- Cambria and Calibri use the production renderer's metric-compatible Caladea and Carlito faces;
- recursive font lookup rejects loose family matches such as `SFGeorgian.ttf` for Georgia;
- mixed inline runs are measured with their own size, weight, style, and line-height contribution;
- overflow repair finds the largest fitting font scale instead of shrinking from overflow height alone, and applies it per run so inline hierarchy is preserved.

All other upstream layout, geometry, atomic patch validation, rendering, and
diff behavior remains unchanged. Regression coverage lives in
`backend/tests/test_hands_on_deck_sophia_patches.py`.
