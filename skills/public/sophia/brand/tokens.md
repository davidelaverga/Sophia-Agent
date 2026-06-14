# Sophia Artifact Brand Tokens

Use these tokens as the default design anchor for Sophia-generated reports,
HTML artifacts, diagrams, and presentation decks. They are intentionally
portable: convert OKLCH to nearest hex when a renderer does not support OKLCH.

## Core Palette

- `ink`: `oklch(18% 0.035 260)` / `#1f2a37`
- `body`: `oklch(35% 0.035 260)` / `#3a4658`
- `muted`: `oklch(51% 0.035 260)` / `#6b7787`
- `paper`: `oklch(99% 0.006 260)` / `#ffffff`
- `surface`: `oklch(96% 0.012 260)` / `#f5f7fa`
- `line`: `oklch(90% 0.018 260)` / `#e3e8ef`
- `blue`: `oklch(48% 0.14 260)` / `#2e5aac`
- `teal`: `oklch(62% 0.13 190)` / `#2a9d8f`
- `gold`: `oklch(76% 0.14 82)` / `#d4af37`
- `coral`: `oklch(64% 0.16 38)` / `#e76f51`

## Usage

- Prefer light, high-contrast report surfaces unless the brief explicitly asks
  for a dark style.
- Use one dominant accent and one supporting accent per artifact.
- Do not use gradients, decorative side stripes, or low-contrast colored text.
- Charts and diagrams must use semantic labels and captions; no placeholder
  categories or values.
- For PPTX, use safe Office fonts: Georgia or Cambria for headings, Calibri or
  Arial for body text.
