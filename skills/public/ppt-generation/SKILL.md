---
name: ppt-generation
description: Use this skill whenever the builder must create a PowerPoint deck or presentation (.pptx). It carries the Sophia deck design system (brand palette, safe fonts, five slide types) and the visual-director logic that varies treatment by content so the deck is not monotonous. Read before building any deck.
---

# Sophia Deck Skill — PPTX

You are composing a **presentation**, not filling a template. Every slide is a deliberate decision about what an idea is and how it should be *seen*. The failure to avoid above all is **monotony** — the same "bullets left, diagram right" on every slide. A deck where every slide looks the same is bad even if each element is correct.

The skill carries the **judgment**; the renderer (`compile_pptx.mjs`) enforces the **design system**.

## 1. Art-direct, then build
Write a **visual plan** first — one line per slide: `Slide N | the one idea | treatment | tool`. Only after the whole plan is checked for variety (§3) do you generate visuals and compose.

## How slides are built

Default deck builds are image-forward: each slide is generated as a full-slide visual with
gpt-image-2 for fresh slide generations — including its title, text, and any technical
drawing — using the structured plan + Sophia's brand style as the spec. Later slides that
reference slide 1 automatically use the image-generation script's edit-supported
`gpt-image-1.5` model.

If the user asked for a plain, text-only, no-image, no-imagery, no-illustration, or
no-visuals deck, preserve that constraint. Do not run the image-generation script, do not
make generated hero slides, and do not add `image_path` / `--slide-images` just because this
skill was read. Compose a deterministic editable PPTX instead: use slide text, shapes,
tables, simple diagrams, and deterministic charts through the PPT generator workflow.

For image-forward runs, compose the prompt as an artifact spec (the script appends brand style
and anti-patterns, so write only the content):

- Declare the artifact ("a professional presentation slide, 16:9").
- Wrap EVERY rendered string as "THE TEXT READS: ...". Keep each label 8 words or fewer.
- State the layout in one explicit sentence (columns, sections, where the visual sits).
- For a technical drawing, list nodes and labeled connections, each wrapped "THE TEXT READS: ...".
- Put EXACT data in the prompt; the model renders what you give it and will not invent numbers.
- Run `python /mnt/skills/public/image-generation/scripts/generate.py --slide-visual`
  (sets quality=high, 16:9). Generate slide 1 first, then pass it as
  `--reference-images` to every later slide for one consistent look; the script switches
  reference-conditioned calls to the edit-supported `gpt-image-1.5` model.
- For image-forward runs, give the cover a generated hero treatment. For plain/no-image runs,
  use a clean typographic cover instead.

Routing: concept, architecture, process, section, cover, statement, and qualitative-comparison
slides are gpt-image-2 full slides. A slide whose point IS hard quantitative data (real numbers
the audience reads) uses a deterministic chart (generate_visual_asset) embedded in an
engine-composed slide instead — accuracy must not depend on image rendering. For plain/no-image
decks, route every slide through deterministic engine-composed text/shape/chart layouts.

QC: every generated slide is checked; a failed slide is regenerated once, then falls back to a
deterministic engine-composed slide. Plain/no-image decks skip generated-slide QC because there
are no generated slide images. Never ship a slide with garbled text or wrong data.
Run the check with `python /mnt/skills/public/image-generation/scripts/slide_qc.py --image-file <slide.png> --spec-file <slide-spec.txt>`; pass slide 1 as `--reference-image` for later slides.

Slide types in the plan: `cover` · `agenda` · `section` · `content` (subtype `text+visual` |
`stat` | `two-column` | `full-visual`) · `statement` · `summary`. Use at least three distinct
types and vary deliberately — no more than two consecutive slides share a treatment. Full-slide
gpt-image-2 visuals use `image_path`; deterministic charts/diagrams use `visual_path`; a
`statement` slide carries a single `statement` string.

## Per-slide prompt template

```
A professional presentation slide, 16:9. Title at top: "THE TEXT READS: {title}".

Layout: {one explicit sentence — e.g. "Left third: four short bullet points stacked
vertically. Right two-thirds: a labeled architecture diagram of boxes connected by arrows."}

Text to render verbatim (each ≤8 words):
- "THE TEXT READS: {point 1}"
- "THE TEXT READS: {point 2}"
{...}

{If a technical drawing: list nodes and connections, each labeled verbatim, e.g.
"Boxes: 'THE TEXT READS: User', 'THE TEXT READS: Companion Layer'. Arrow from User to
Companion Layer labeled 'THE TEXT READS: talks to'."}

High-fidelity, sharp, crisp, presentation-grade.
```

## 7. Workflow
Plan & art-direct (variety check) → generate visuals (diagrams: short labels; charts: real labels + data; illustrations: one style) → compose the plan JSON → render → **visual QA**, fix once.

## 8. QA checklist
Correctness (no overlap/clipping; real chart/diagram labels and values; no "Item N"/blank images) · Legibility (contrast; nothing dark-on-dark) · Variety (≤2 adjacent same treatment; deck has rhythm) · Fit (each visual matches its content) · Cohesion (one illustration style; consistent palette/type). A correct-but-monotonous deck fails QA.
