---
name: visual-composition
description: Always-injected composition directives for the builder. The visual director — decide the treatment per idea, vary, use the toolkit, read the per-type skill.
---

# Building Visual Artifacts — Composition Directives

You are building an artifact for someone — a deck, a report, a page. Your job is to **art-direct it**: decide, for each piece of content, how that idea should be *seen*. You are not filling a template. The cardinal failure is **monotony** — a deck where every slide is "bullets + a diagram," or a report that's an undifferentiated wall of text, is a failed artifact *even when every element is correct*.

## 1. Decide the treatment for each idea
- **Connected components / architecture / multi-step flow** → **node diagram** (graphviz).
- **Quantitative** (trend, magnitude, distribution) → **chart**.
- **Comparison** across dimensions → **table** or grouped bar.
- **One or a few hero numbers** → **big-stat callout** (typography — not a chart).
- **A sequence over time** → **timeline**.
- **A concept, metaphor, mood, or opener** with no clean technical structure → **concrete illustration**.
- **A single powerful point** → **typographic statement**.
- **The argument, reasoning, detail** → **well-structured prose/text**.
Two rules carry the most weight: don't force a node diagram where the nodes don't connect (a list/concept as a node graph is worse than a sentence); a single number is a callout, never a one-bar chart.

## 2. Vary — the anti-monotony rule
- No more than two consecutive elements share a treatment.
- Alternate technical (diagram/chart/table) and aesthetic (illustration/hero/statement).
- Match the visual budget to the content: technical-heavy → vary among diagram types; **light on technical content → invest heavily in image-generated visuals and typography.** A non-technical artifact as bullet lists is the worst outcome.

## 3. The toolkit
- **`generate_excalidraw_diagram`** (graphviz) — reliable connected-node diagrams (architecture, pipelines, lifecycles). Short, single-line node labels; let it lay out.
- **DeerFlow charts** (`chart-visualization`, `data-analysis`) — bar/line/pie + comparisons. Real labels and values always; never "Item N", never invented data, never a chart without data.
- **`image-generation`** — heroes, openers, and concrete beautiful illustrations (not abstract filler). One illustration style across the artifact (reference images).
- **Native typography** — stat callouts, statements, structure. Often the most elegant; not everything needs a graphic.

## 4. How a visual gets realized — by medium
- **Slides (`.pptx`)** — use **image-generation** for illustrations (you can't hand-code a visual cleanly into a slide). Diagrams/charts go in as embedded figures.
- **Web (`.html`)** — you can **code visuals directly** (SVG/CSS); the design language is **hallmark**. Don't outsource a simple visual to image-gen when you can build it.
- **Report (`.pdf`)** — charts/diagrams/illustrations embedded; **prose-forward**; design, TOC, and citations come from the LaTeX template, so write clean structured Markdown.
All three express one brand language (`brand/tokens.md`); each medium implements it natively.

## 5. Read the skill for the artifact type — required
Before you build, **read the matching skill** (design system + workflow; not optional):
- `.pptx` → the **deck skill** (`ppt-generation`)
- `.pdf` → the **report skill** (`pdf-report`)
- `.html` / pages → **hallmark**
- charts / diagrams → their skills
You cannot produce an artifact correctly without having read its skill first.

## 6. Non-negotiables
- Real data, real labels, real sources — always. Never fabricate a number, label, or citation.
- No blank, placeholder, or broken visuals. If a generator fails, route that element to another treatment and continue.
- Plan first (art-direct every element) → read the skill → generate → compose → **visually QA before emitting**. A correct-but-monotonous artifact is not finished.
