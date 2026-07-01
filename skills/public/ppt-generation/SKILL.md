---
name: ppt-generation
description: Use this skill whenever the builder must create a PowerPoint deck or presentation (.pptx). Sophia decks are authored as one self-contained HTML file per slide; the build system renders each slide and converts the deck to PPTX. You never write python-pptx or run a compiler script — you call build_deck_from_slides once.
---

# Sophia Deck Skill — PPTX (HTML slides)

A deck is a set of **slide HTML files**. You author the HTML; the build system
renders each slide to a full-bleed image and converts the deck to PPTX. **You do
not compile the deck yourself.** Each slide is a self-contained `1920×1080` HTML
document — real DOM text (a crisp title + concise narrative) plus AT MOST one
generated VISUAL-ONLY image referenced by a **relative** `../assets/<file>`
path. This is the same Chromium substrate the PDF report path uses. Default to
a restrained professional technical aesthetic unless the user explicitly asks
for a different style.

A slide may omit the image when the request is plain — honor no-image deck
requests by authoring a clean text-only slide. Never invent decorative imagery
the user did not ask for.

## Building a deck

1. **Plan the slides** — slide count and, per slide: the title, the
   body/narrative, and the visual to generate (if any).
2. **Generate each slide's image into the deck `assets/` folder.** Use the
   image-generation skill in `--slide-visual` mode (the VISUAL AREA ONLY — no
   title, narrative, diagram labels, formulas, axis labels, or chrome baked in;
   those are real HTML text in the slide). Write the PNG under `/mnt/user-data/outputs/assets/`. Generate the
   hero/cover first, then the rest in ONE `--manifest` batch (each item
   referencing the hero PNG in `reference_images` for visual consistency):
   ```bash
   # hero first (anchors the visual style)
   python /mnt/skills/public/image-generation/scripts/generate.py \
     --slide-visual \
     --prompt-file /mnt/user-data/outputs/assets/01-cover.prompt.json \
     --output-file /mnt/user-data/outputs/assets/01-cover.png
   # then ONE batch for the rest (each item: "slide_visual": true,
   # "reference_images": [".../assets/01-cover.png"])
   python /mnt/skills/public/image-generation/scripts/generate.py \
     --manifest /mnt/user-data/outputs/assets/manifest.json
   ```
   Every manifest item for deck assets must include `"slide_visual": true` so
   generation uses the visual-region contract instead of the generic image
   prompt path. The batch items run concurrently (bounded for API rate limits)
   and print one `IMAGEGEN_BATCH {...}` summary line. Generated images are
   written as **local files** — reference them by relative path from your slide
   HTML, never a remote URL.
3. **Author one self-contained HTML file per slide** under
   `/mnt/user-data/outputs/slides/`, named so they sort in order (e.g.
   `slides/01-cover.html`, `slides/02-overview.html`). Each is a `1920×1080`
   document. Use the skeleton below. Reference the slide's image by **relative**
   path only (`../assets/01-cover.png`). A slide without a visual simply omits
   the `.visual` block.
4. **Convert to PPTX.** Call the build tool once:
   ```
   build_deck_from_slides(output_path="/mnt/user-data/outputs/<deck>.pptx", title="<Deck title>")
   ```
   The build system renders every `slides/*.html` to a full-bleed PNG and wraps
   them into the `.pptx`. It returns the `.pptx` path and slide count.
5. **Emit** the returned `.pptx` with `emit_builder_artifact(artifact_type="presentation")`.

## Slide HTML skeleton

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  /* A slide is exactly the deck canvas. No scroll, no margins. The page
     background MUST be opaque too — if any region is left uncovered it
     renders in THIS color, never transparent/white by accident. */
  html, body { margin: 0; padding: 0; background: #f7f9fc; }
  .slide {
    width: 1920px; height: 1080px; box-sizing: border-box;
    background: #f7f9fc; color: #1f2a37; overflow: hidden; position: relative;
    font-family: "Helvetica Neue", Arial, sans-serif;
  }
  .slide .title { position: absolute; top: 64px; left: 80px; right: 80px;
    font-size: 64px; font-weight: 700; line-height: 1.1; }
  .slide .visual { position: absolute; top: 200px; left: 80px; right: 80px; bottom: 200px; }
  /* Diagram/content slides: `contain` keeps the whole image visible; any
     letterbox gap renders in the slide's opaque background, not white by accident.
     For a hero/cover or full-bleed visual, make the image cover the whole slide
     instead — a full-frame `.slide .visual { inset: 0 }` + `object-fit: cover`. */
  .slide .visual img { width: 100%; height: 100%; object-fit: contain; }
  .slide .narrative { position: absolute; left: 80px; right: 80px; bottom: 72px;
    font-size: 30px; line-height: 1.35; color: #4b5b73; }
</style>
</head>
<body>
  <div class="slide">
    <div class="title">Slide title</div>
    <div class="visual"><img src="../assets/01-cover.png" alt="..."></div>
    <div class="narrative">One or two sentences of supporting narrative.</div>
  </div>
</body>
</html>
```

## Hard rules

- **You author HTML only.** You never author or run deck-compilation code. Do NOT
  write `python-pptx` or `pptxgenjs` code, do NOT call any deck compiler, do NOT
  run `bash` to assemble a deck. Always finish by calling
  `build_deck_from_slides(...)` once — the build system converts your slide HTML
  to PPTX.
- **The slide must be opaque to all four edges.** The background may be light or
  dark according to the deck style and user request, but never leave the page
  background transparent or accidentally white: set an opaque background on
  `html, body` AND on the slide wrapper, and prefer full-bleed visuals for
  hero/cover slides. A stray band or gutter at any edge is a defect.
- **Every slide visual is a relative `../assets/<file>` path.** A remote URL in a
  slide is an error — generate images into `assets/` first. A slide may also have
  no image at all when the content is plain text.
- **The generated image is the visual area only.** Titles, narrative, formulas,
  axis labels, diagram labels, and annotations are real HTML text in
  `slides/*.html`; never bake a title, footer, narrative, page chrome, or large
  typography into the image unless the user explicitly requests image-baked text.
- **Default aesthetic:** restrained professional technical. Do not use
  chalkboard, handwritten, whiteboard, sketch, playful, or classroom styles
  unless the user explicitly requests that look.
- Generate images into `/mnt/user-data/outputs/assets/`; author slides into
  `/mnt/user-data/outputs/slides/`; the deck is built to
  `/mnt/user-data/outputs/<deck>.pptx`.
- Keep visible slide text concise (title 4–9 words; narrative 1–2 sentences). The
  text is real HTML now — it renders crisply, but a wall of text still looks bad.
- **No invented chrome.** A slide is ONLY a title, a visual, and a concise
  narrative. Do NOT add a top eyebrow/nav row, a bottom icon strip, a page-number
  footer (`page 2 of 4`), breadcrumbs, or `<nav>`/`<footer>` elements. The harness
  flags these and makes you re-author the slide.
- **Density: at most ~3 short columns and a comfortable amount of body text per
  slide.** If the content does not fit at a comfortable size, CUT content — do NOT
  shrink the font or cram more columns. Content that overruns the 1920×1080 frame
  is clipped by the renderer; the harness measures this and rejects a clipped
  slide for one re-author.

## QA Checklist

- Slides authored as `slides/*.html`; images in `assets/`, referenced relatively.
- The deck was produced by `build_deck_from_slides`, not hand-written PPTX code.
- At most one image per slide; titles/narrative/labels are real HTML text,
  legible and not clipped, never baked into the image by default.
- Plain (no-image) requests ship clean text-only slides.
- Expected slide count; correct primary extension `.pptx`.
- Emit promptly once the build returns a valid `.pptx`.
