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
reference slide 1 use the image-generation script's `gpt-image-2` edit path.

Before generating slide 1, choose exactly one `visual_style` for the deck from
`/mnt/skills/public/image-generation/references/manifest.json`. Use that same
`visual_style` on every generated slide; vary the `diagram_type`/composition inside the
style instead of mixing styles across the deck. If the chosen style has a matching
reference image for the diagram type, pass it with `--reference-images`; if not, rely on
the style's prompt anchor and no reference.

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
- Include the chosen `visual_style` and diagram family in every prompt.
- Add concise `speaker_notes` for every content slide: 1-2 sentences that narrate the
  slide. These notes are not visible on the slide canvas.
- Every image-forward content/diagram slide also carries a visible `caption` or `takeaway`:
  one short sentence stating the point the slide makes, not a label restatement. The compiler
  renders it in a reserved bottom band. Cover, section, statement, summary, agenda, and closing
  slides are exempt.
- Run `python /mnt/skills/public/image-generation/scripts/generate.py --slide-visual`
  (sets quality=high, 16:9). Generate slide 1 first, then pass it as
  `--reference-images` to every later slide for one consistent look; the script keeps
  reference-conditioned calls on `gpt-image-2` through `client.images.edit`.
- For image-forward runs, give the cover a generated hero treatment. For plain/no-image runs,
  use a clean typographic cover instead.

Routing: concept, architecture, process, section, cover, statement, and qualitative-comparison
slides are gpt-image-2 full slides. A slide whose point IS hard quantitative data (real numbers
the audience reads) uses a deterministic chart (generate_visual_asset) embedded in an
engine-composed slide instead — accuracy must not depend on image rendering. For plain/no-image
decks, route every slide through deterministic engine-composed text/shape/chart layouts.

A slide whose entire point is hard quantitative data the audience must read may be a deterministic data chart — set `data_chart: true` on that slide. Everything else (concept, architecture, process, section, cover) is gpt-image-2.

QC: every generated slide is checked; a failed slide is regenerated or re-prompted once. Do not
downgrade a concept, architecture, process, section, cover, or qualitative comparison slide to a
deterministic engine-composed slide. The only deterministic exception is a true hard-data chart
whose point is exact numeric reading. Plain/no-image decks skip generated-slide QC because there
are no generated slide images. Never ship a slide with garbled text or wrong data.
Run the check with `python /mnt/skills/public/image-generation/scripts/slide_qc.py --image-file <slide.png> --spec-file <slide-spec.txt>`; pass slide 1 as `--reference-image` for later slides.

Slide types in the plan: `cover` · `agenda` · `section` · `content` (subtype `text+visual` |
`stat` | `two-column` | `full-visual`) · `statement` · `summary`. Use at least three distinct
types and vary deliberately — no more than two consecutive slides share a treatment. Full-slide
gpt-image-2 visuals use `image_path`; deterministic hard-data charts use `visual_path`; a
`statement` slide carries a single `statement` string. Every generated slide in the plan must
carry the same `visual_style`. Set `title_strategy: "baked"` only when the title is intentionally
rendered into the image and QC confirms the title is present; otherwise use
`title_strategy: "native"` so the compiler owns the title overlay. Keep `speaker_notes` for
concise narration, but do not rely on notes as the only narrative: image-forward content slides
need a visible `caption`/`takeaway` too.

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

## Prompting gpt-image-2 for slide visuals (diagrams, charts, infographics)

When creating a full-slide visual, use gpt-image-2 through the image-generation script, not deterministic diagram code.

Use this prompt structure:

1. State: “A professional presentation slide, 16:9.”
2. Describe the topic and purpose in one sentence.
3. Specify a title and all important labels as exact text:
   “THE TEXT READS: …”
4. Limit slide text:
   - title: 4–8 words
   - labels: 1–5 words
   - at most 20 total words unless the user explicitly requests more
5. Specify layout:
   - cover / section divider / process flow / architecture map / timeline /
     comparison / quadrant / metric story / concept map
6. Specify hierarchy:
   - primary focus
   - secondary supporting details
   - where the eye should go first
7. Specify Sophia style:
   - the deck's chosen `visual_style`, brand palette, high contrast, no generic
     AI gradient, no stock template look.
8. If a later slide, include reference-image continuity:
   - “Use the reference slide’s palette, typography feeling, spacing discipline,
     and visual language.”

Then run:

`python /mnt/skills/public/image-generation/scripts/generate.py --slide-visual ...`

If generated text is wrong, regenerate with a stricter prompt. Do not accept garbled text.

## 7. Workflow
Plan & art-direct (choose one deck `visual_style`, vary diagram types) → generate visuals
(diagrams: short labels; hard-data charts: real labels + data) → compose the plan JSON with
`visual_style`, `title_strategy`, and `speaker_notes` → render → **visual QA**, fix once.

## 8. QA checklist
Correctness (no overlap/clipping; real chart/diagram labels and values; no "Item N"/blank images) · Legibility (contrast; nothing dark-on-dark) · Variety (≤2 adjacent same treatment; deck has rhythm) · Fit (each visual matches its content) · Cohesion (one illustration style; consistent palette/type). A correct-but-monotonous deck fails QA.

Use the shared Sophia anti-slop rubric (`/mnt/skills/public/sophia/anti_slop.md`) before emitting.

## Diagram vocabulary and routing

Match the visual TYPE to the content; do not use one diagram style for everything.

Types:
- Nested-container architecture: components grouped inside labeled rounded panels (a panel holds
  its sub-nodes), labeled arrows, dashed boxes for optional parts. Soft palette. Use for systems.
- Swimlane / Gantt: color-coded blocks across a time axis, staggered to show overlap. Use for
  parallel or staged processes (pipelines, async stages).
- Comparison panels: 2-3 side-by-side panels with the same slots, to contrast approaches/paradigms.
- Multi-panel chart (small multiples): N chart panels + one shared legend, for multi-task data.
- Conceptual metaphor: an illustrative scene (e.g. a landscape) with annotated paths + a small
  "term -> term" mapping panel, for abstract ideas.

Route by complexity x text-density x structural-precision:
- Simple / conceptual / loose structure / sparse text  -> gpt-image-2 (style-anchored, see below).
- Precise / dense text / exact structure (>9 nodes, math notation) -> deterministic rendering;
  if it must stay one figure, render it deterministically rather than image-gen.
- Too complex for one figure (>9 nodes)  -> DECOMPOSE into 2-3 focused sub-diagrams first, then
  route each piece by the rule above.

Enforce diagram-TYPE variety across a deck while preserving one visual style.

Style anchor (for technical slide visuals via gpt-image-2): read
`/mnt/skills/public/image-generation/references/manifest.json`, choose one `visual_style`, use
that style's `prompt_anchor`, then spell out containers/nodes/arrows with "THE TEXT READS: ...",
then the brand palette. Pass a reference image only when the manifest lists a real ref for that
style and diagram type. Reference sets the look; the prompt sets the structure.
