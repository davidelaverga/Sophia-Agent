---
name: pdf-report
description: Use this skill whenever the builder must create a PDF report, brief, explainer, or technical document. Sophia PDF reports are authored as ONE self-contained HTML file with inline <svg> figures and rendered to PDF with render_html_to_pdf (headless Chromium).
---

# Sophia Report Skill — PDF (HTML → PDF)

Sophia PDF reports are authored as **one self-contained HTML file** and rendered
to PDF with `render_html_to_pdf` (headless Chromium). You draw every chart and
diagram yourself as **inline static `<svg>`** — deterministic, local, no remote
chart service, no client-side JavaScript. The renderer owns page size, margins,
and the page-number footer.

**Why HTML+SVG (not Markdown/pandoc, not `generate_chart`):** the remote chart
service rendered empty charts and failed structural-diagram families in
production. Inline SVG you author always renders, exactly as written.

Do not use full-slide deck images (`--slide-visual` gpt-image output) in PDF
reports. Generated imagery is limited to the bounded conceptual/editorial
illustrations in step 5. Do not emit the HTML source or any preview file as the
final artifact unless explicitly requested.

## Workflow

1. Plan the section spine, target page count, and figure placements.
2. Research as needed and preserve citations.
3. Create ONE HTML file under `/mnt/user-data/outputs/` (e.g. `report.html`):
   - Start from the **Document skeleton** below.
   - Inline the FULL contents of `assets/report.css` into the first `<style>`
     block so the document is self-contained.
   - Write the cover, optional TOC, sections, prose, tables, and callouts.
4. Draw every figure as **inline `<svg>`** using the **Pattern library** below.
   Fill the patterns with real labels and values. Vary the figure family —
   never route every figure to the same kind.
5. Optional: up to **3 conceptual/editorial illustrations** (a cover/hero plus
   key concepts) via the image-generation skill — no text baked into the image,
   theme-matched palette. Reference them as `<img src="visuals/<name>.png">`.
   All DATA and STRUCTURE stays inline `<svg>`; generated images are conceptual
   only.
6. Render with `render_html_to_pdf(html_path=..., pdf_path=..., requested_pages=...)`,
   passing the page-count parameters when the user asked for a length.
7. Inspect the render result. Repair a missing figure or page-count drift once.
8. Emit the `.pdf` as the primary artifact.

## Document skeleton

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Report title</title>
<style>
/* paste the FULL contents of assets/report.css here */
</style>
</head>
<body>
  <section class="cover">
    <h1>Report Title</h1>
    <p class="subtitle">One-line subtitle or scope</p>
    <p class="meta">Prepared for … · 2026</p>
  </section>

  <section class="toc">
    <h2>Contents</h2>
    <ol>
      <li><span>1. Section one</span><span>3</span></li>
      <li><span>2. Section two</span><span>5</span></li>
    </ol>
  </section>

  <section>
    <h2>1. Section one</h2>
    <p>Prose…</p>
    <figure>
      <p class="figure-title">Figure 1. Title</p>
      <!-- inline <svg> here -->
      <figcaption>Source-aware caption.</figcaption>
    </figure>
  </section>
</body>
</html>
```

## Pattern library (inline SVG)

Copy a pattern, set the `viewBox` width to ~640, and fill in real values. Use
the CSS custom properties (`var(--accent)`, etc.) for series colors so figures
match the theme. Keep text ≥ 11px in user units so it stays legible at print DPI.

### Vertical bar chart

```html
<svg viewBox="0 0 640 320" role="img" aria-label="Bar chart" font-family="Helvetica Neue, Arial, sans-serif">
  <!-- axes -->
  <line x1="60" y1="20" x2="60" y2="270" stroke="#d7dce4"/>
  <line x1="60" y1="270" x2="620" y2="270" stroke="#d7dce4"/>
  <!-- y gridlines + labels (set max to your data max) -->
  <g fill="#424a57" font-size="11" text-anchor="end">
    <text x="54" y="274">0</text><text x="54" y="149">50</text><text x="54" y="24">100</text>
  </g>
  <line x1="60" y1="145" x2="620" y2="145" stroke="#eef1f6"/>
  <!-- bars: x evenly spaced; height = value/max * 250 -->
  <g fill="#2f6df6">
    <rect x="90"  y="120" width="70" height="150"/>
    <rect x="200" y="70"  width="70" height="200"/>
    <rect x="310" y="170" width="70" height="100"/>
    <rect x="420" y="45"  width="70" height="225"/>
  </g>
  <!-- category labels -->
  <g fill="#14181f" font-size="11" text-anchor="middle">
    <text x="125" y="286">Q1</text><text x="235" y="286">Q2</text>
    <text x="345" y="286">Q3</text><text x="455" y="286">Q4</text>
  </g>
</svg>
```

### Line / trend chart

```html
<svg viewBox="0 0 640 320" role="img" aria-label="Line chart" font-family="Helvetica Neue, Arial, sans-serif">
  <line x1="60" y1="20" x2="60" y2="270" stroke="#d7dce4"/>
  <line x1="60" y1="270" x2="620" y2="270" stroke="#d7dce4"/>
  <!-- polyline: map each (x,y) into the plot box (x:60–620, y:20–270 inverted) -->
  <polyline fill="none" stroke="#2f6df6" stroke-width="2.5"
            points="60,250 200,200 340,150 480,90 620,60"/>
  <!-- point markers -->
  <g fill="#2f6df6"><circle cx="200" cy="200" r="3"/><circle cx="340" cy="150" r="3"/><circle cx="480" cy="90" r="3"/></g>
  <g fill="#14181f" font-size="11" text-anchor="middle">
    <text x="60" y="286">2021</text><text x="340" y="286">2023</text><text x="620" y="286">2025</text>
  </g>
</svg>
```

### Box-and-arrow flow / process

```html
<svg viewBox="0 0 640 160" role="img" aria-label="Process flow" font-family="Helvetica Neue, Arial, sans-serif">
  <defs>
    <marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#424a57"/>
    </marker>
  </defs>
  <g>
    <rect x="20"  y="55" width="130" height="50" rx="6" fill="#f5f7fb" stroke="#2f6df6"/>
    <rect x="255" y="55" width="130" height="50" rx="6" fill="#f5f7fb" stroke="#2f6df6"/>
    <rect x="490" y="55" width="130" height="50" rx="6" fill="#f5f7fb" stroke="#2f6df6"/>
  </g>
  <g fill="#14181f" font-size="12" text-anchor="middle">
    <text x="85"  y="84">Collect</text><text x="320" y="84">Process</text><text x="555" y="84">Deliver</text>
  </g>
  <g stroke="#424a57" stroke-width="1.5" marker-end="url(#arrow)">
    <line x1="150" y1="80" x2="250" y2="80"/><line x1="385" y1="80" x2="485" y2="80"/>
  </g>
</svg>
```

### Comparison / two-panel or grouped bars

```html
<svg viewBox="0 0 640 300" role="img" aria-label="Comparison" font-family="Helvetica Neue, Arial, sans-serif">
  <g fill="#14181f" font-size="12" font-weight="600" text-anchor="middle">
    <text x="170" y="28">Option A</text><text x="470" y="28">Option B</text>
  </g>
  <!-- grouped bars: accent vs accent-2 -->
  <g><rect x="120" y="120" width="40" height="140" fill="#2f6df6"/><rect x="170" y="80" width="40" height="180" fill="#16a36a"/></g>
  <g><rect x="420" y="160" width="40" height="100" fill="#2f6df6"/><rect x="470" y="60" width="40" height="200" fill="#16a36a"/></g>
  <line x1="40" y1="260" x2="600" y2="260" stroke="#d7dce4"/>
  <g font-size="11"><rect x="40" y="278" width="11" height="11" fill="#2f6df6"/><text x="56" y="288" fill="#424a57">Cost</text>
  <rect x="120" y="278" width="11" height="11" fill="#16a36a"/><text x="136" y="288" fill="#424a57">Value</text></g>
</svg>
```

### Donut / composition (only when shares justify it)

```html
<svg viewBox="0 0 320 220" role="img" aria-label="Composition" font-family="Helvetica Neue, Arial, sans-serif">
  <!-- stroke-dasharray = arc_len, circumference-arc_len; circumference = 2*pi*70 ≈ 440 -->
  <g transform="translate(110,110)" fill="none" stroke-width="34">
    <circle r="70" stroke="#eef1f6" stroke-dasharray="440 0"/>
    <circle r="70" stroke="#2f6df6" stroke-dasharray="220 440" transform="rotate(-90)"/>
    <circle r="70" stroke="#16a36a" stroke-dasharray="132 440" stroke-dashoffset="-220" transform="rotate(-90)"/>
  </g>
  <g font-size="11" fill="#424a57">
    <rect x="220" y="80" width="11" height="11" fill="#2f6df6"/><text x="236" y="90">50% A</text>
    <rect x="220" y="104" width="11" height="11" fill="#16a36a"/><text x="236" y="114">30% B</text>
  </g>
</svg>
```

For a single number, use a `.stat` callout (see CSS), not a chart.

## Figure grammar

Pick the figure form that matches the content:

- Architecture/system structure → box-and-arrow with nested containers.
- Process → flow / sequence / lifecycle / timeline.
- Comparison → table, side-by-side panels, or grouped bars.
- Quantitative trend → line chart.
- Composition/share → donut or stacked bar (only when values justify it).
- One/few numbers → stat callout, not a chart.

Avoid repetitive diagrams. A report with several figures should show more than
one grammar when the source material supports it. **For four or more figures, no
single grammar may account for more than 50% of embedded figures** — mix at
least one chart and at least one table/structural diagram. Repetition is
acceptable only when repeated measurement is the actual analytic point.

## Figure requirements

- Use real labels and values. Never invent placeholder data.
- Every figure is inline `<svg>` (or, for the ≤3 conceptual images, a local
  `<img src="visuals/<name>.png">`). No remote image URLs, no `<script>`,
  no external chart libraries.
- Wrap each figure in `<figure>` with a `.figure-title` and a `<figcaption>`.
- Keep captions specific and source-aware.

## HTML requirements

- One self-contained `.html` file; inline the base CSS in a `<style>` block.
- Do NOT add your own `@page` margin or page-number footer — `render_html_to_pdf`
  supplies them.
- Use clean heading levels (`h1`/`h2`/`h3`) so the document reads coherently.
- Cite researched claims inline.
- Prefer prose over unnecessary graphics.
- Use HTML `<table>` for tabular comparisons.
- **Code blocks:** always `<pre><code>…</code></pre>`. The base CSS wraps long
  lines — a PDF page has NO horizontal scroll, so an unwrapped line is clipped
  at the right margin. Keep lines short where practical; never rely on scroll.
- **Side-by-side content:** use `<div class="cols-2">…</div>` (a safe grid). Do
  NOT place a wide table beside a code block — they collide; stack full-width
  blocks vertically instead. A wide comparison table spans the full page width,
  never a half-column shared with code.
- **Eyebrow / section labels:** use `<p class="section-label">…</p>` (handles
  uppercase + letter-spacing without clipping the first glyph) — do not hand-roll
  `letter-spacing` on an ad-hoc element.

## QA checklist

- Requested `.pdf` exists and opens.
- Page count is near the requested target, or the render result explains the
  bounded drift.
- Headings and (if present) TOC are coherent.
- Citations are present where factual claims require them.
- Figures are inline SVG, render with real series/labels (not empty frames),
  legible, varied when appropriate, and not repeated from one generic template.
- No code line is clipped at the page edge (use `<pre>`; the CSS wraps it).
- No column overlaps or clips its neighbor (use `.cols-2`; don't pair a wide
  table with code).
- Only the primary PDF is user-visible by default.
