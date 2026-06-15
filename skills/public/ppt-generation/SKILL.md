---
name: ppt-generation
description: Use this skill whenever the builder must create a PowerPoint deck or presentation (.pptx). It carries the Sophia deck design system (brand palette, safe fonts, five slide types) and the visual-director logic that varies treatment by content so the deck is not monotonous. Read before building any deck.
---

# Sophia Deck Skill — PPTX

You are composing a **presentation**, not filling a template. Every slide is a deliberate decision about what an idea is and how it should be *seen*. The failure to avoid above all is **monotony** — the same "bullets left, diagram right" on every slide. A deck where every slide looks the same is bad even if each element is correct.

The skill carries the **judgment**; the renderer (`compile_pptx.mjs`) enforces the **design system**.

## 1. Art-direct, then build
Write a **visual plan** first — one line per slide: `Slide N | the one idea | treatment | tool`. Only after the whole plan is checked for variety (§3) do you generate visuals and compose.

## 2. Decide the treatment (see the always-on composition directives for the full taxonomy)
- Connected components / architecture / multi-step flow → **node diagram** (`generate_excalidraw_diagram`, graphviz).
- Quantitative → **chart** (`chart-visualization`).
- Comparison → **table** or grouped bar.
- One/few hero numbers → **`stat` callout** (typography — not a chart).
- Time sequence → **timeline**.
- Concept / metaphor / opener with no technical structure → **illustration** (`image-generation`).
- A single point → **typographic statement**.
- Don't force a node diagram where nodes don't connect; a single number is a callout, never a one-bar chart.

## 3. Variety & cadence
- No more than two consecutive slides share a treatment.
- Alternate technical (diagram/chart/table) and aesthetic (illustration/hero/statement).
- **Light on technical content → invest heavily in image-gen visuals and typography.** A non-technical deck as bullet lists is the worst outcome.
- Healthy shape: hero cover → agenda → diagram → stat → section (visual) → chart → illustrated concept → comparison table → statement → summary. No two adjacent slides alike. Squint test: one clear focal point per slide.

## 4. Image generation for slides
Use it for heroes, section dividers, **and** concrete illustrations — not only abstract fills. Make illustrations a depicted idea, beautiful and concrete. **Hold one illustration style across the deck** (reuse reference images) for cohesion. Full-bleed for impact; contained beside text for content; background only with a contrast scrim. If preflight fails, route those slides to typographic/charted treatments.

## 5. Design system (enforced by the engine)
- Palette: brand themes (`sophia_light` default), one dominant + one supporting accent. Palette colors only.
- Fonts: **Cambria** headings, **Calibri** body. Never Aptos/Georgia.
- No accent bars/stripes; no dark-on-dark; no text-only and no image-album slides. Hierarchy via size/weight/color, not boxes. ≥0.5" margins.

## 6. Slide types & plan schema
Cover · Agenda · Section · Content(`text+visual` | `stat` | `two-column` | `full-visual`) · Summary. Emit the plan JSON the engine consumes (charts/diagrams as `visual_path`; illustrations as `image_path`; stats carry no image):
```json
{"theme":"sophia_light","slides":[
  {"type":"cover","title":"...","subtitle":"...","image_path":"assets/hero.png"},
  {"type":"content","subtype":"text+visual","title":"...","body":["..."],"visual_path":"assets/arch.svg"},
  {"type":"content","subtype":"stat","title":"...","stat":"3,000+","stat_label":"...","support":"..."},
  {"type":"summary","title":"...","points":["..."]}
]}
```

## 7. Workflow
Plan & art-direct (variety check) → generate visuals (diagrams: short labels; charts: real labels + data; illustrations: one style) → compose the plan JSON → render → **visual QA**, fix once.

## 8. QA checklist
Correctness (no overlap/clipping; real chart/diagram labels and values; no "Item N"/blank images) · Legibility (contrast; nothing dark-on-dark) · Variety (≤2 adjacent same treatment; deck has rhythm) · Fit (each visual matches its content) · Cohesion (one illustration style; consistent palette/type). A correct-but-monotonous deck fails QA.
