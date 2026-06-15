---
name: sophia-brand-tokens
description: The single source of truth for Sophia artifact design — colors, fonts, and the chart/diagram/engine palettes. All artifact skills and engines draw from this.
---

# Sophia Artifact Brand Tokens

The design anchor for every Sophia artifact (reports, HTML, diagrams, decks).
OKLCH is canonical; the hex beside it is the portable fallback for renderers
without OKLCH (LaTeX, PptxGenJS, graphviz).

## Core palette

| Token | OKLCH | Hex | Role |
|---|---|---|---|
| `ink` | `oklch(18% 0.035 260)` | `#1F2A37` | primary text / titles |
| `body` | `oklch(35% 0.035 260)` | `#3A4658` | body text |
| `muted` | `oklch(51% 0.035 260)` | `#6B7787` | secondary text, captions |
| `paper` | `oklch(99% 0.006 260)` | `#FFFFFF` | background |
| `surface` | `oklch(96% 0.012 260)` | `#F5F7FA` | panels, fills, callout backgrounds |
| `line` | `oklch(90% 0.018 260)` | `#E3E8EF` | borders, rules |
| `blue` | `oklch(48% 0.14 260)` | `#2E5AAC` | **primary accent** |
| `teal` | `oklch(62% 0.13 190)` | `#2A9D8F` | **supporting accent** |
| `gold` | `oklch(76% 0.14 82)` | `#D4AF37` | tertiary accent (sparing) |
| `coral` | `oklch(64% 0.16 38)` | `#E76F51` | tertiary accent (sparing) |

## Chart palette (categorical, in order)

Use this ordered sequence for chart series so every chart is on-brand and consistent:

`#2E5AAC` (blue) → `#2A9D8F` (teal) → `#D4AF37` (gold) → `#E76F51` (coral) → `#6B7787` (muted) → `#1F2A37` (ink)

- Sequential/intensity ramps: tints of `blue` (`#2E5AAC` → `#6E92CE` → `#ABC2E4`).
- Grid lines: `line` `#E3E8EF`. Axis text: `muted` `#6B7787`. No 3-D, no heavy gridlines.

## Diagram palette (graphviz node fills, by semantic group)

| Group | Fill | Border | Use for |
|---|---|---|---|
| `primary` | `#DBEAFE` | `#2E5AAC` | the core component / agent |
| `process` | `#DCFCE7` | `#2A9D8F` | tools, processing, actions |
| `data` | `#EDE9FE` | `#7C3AED` | stores, memory, state |
| `accent` | `#FEF3C7` | `#D4AF37` | triggers, scheduled, special |
| `neutral` | `#F1F5F9` | `#6B7787` | external / supporting |

Edges: `#6B7787`; emphasized edges: `#2E5AAC`. Node text: `ink` `#1F2A37`.

## Fonts

- **PPTX (Office-safe only):** headings **Cambria**; body **Calibri** (Arial acceptable). **Never Aptos or Georgia** — they substitute with wrong metrics under the LibreOffice QA renderer and break title layout.
- **PDF (LaTeX/xelatex):** headings **TeX Gyre Heros** (sans); body **TeX Gyre Pagella** (serif); mono **TeX Gyre Cursor**. (Bundled with `texlive-fonts-extra`; Liberation Sans/Serif as fallback.) Swap in a licensed brand display font later by installing it and changing the `fontspec` lines only.
- **HTML:** per hallmark's type system, anchored to this palette.

## Usage rules

- Light, high-contrast surfaces by default unless the brief explicitly asks for dark.
- **One dominant accent + one supporting accent per artifact** (default: `blue` + `teal`).
- No gradients-as-decoration, no side stripes, no low-contrast colored text.
- Charts and diagrams use semantic labels and captions — never placeholder categories or values.
- Body text must clear WCAG-AA contrast against its background.
