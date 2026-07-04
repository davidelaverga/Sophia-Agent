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

Only an explicitly plain text-only/no-visual deck request may omit slide images.
For normal presentation decks, every slide must have a generated local visual
asset; never compile a no-image deck after image generation fails.

## Building a deck

1. **Plan the slides** — slide count and, per slide: the title, the
   body/narrative, and the visual to generate (if any).
2. **Generate each slide's image into the deck `assets/` folder.** Use the
   image-generation skill in `--slide-visual` mode (the VISUAL AREA ONLY — no
   title, narrative, diagram labels, formulas, axis labels, or chrome baked in;
   those are real HTML text in the slide). Write the PNG under `/mnt/user-data/outputs/assets/`.
   Write one prompt JSON file per slide, including the hero/cover. Then call
   `prepare_pptx_image_manifest(prompt_files=[...])`; do not hand-write the
   batch manifest JSON. Run the returned `manifest_path` in ONE `--manifest`
   batch. Use consistent shared style instructions across prompt JSON files
   instead of relying on a serial hero reference:
   ```bash
   python /mnt/skills/public/image-generation/scripts/generate.py \
     --manifest /mnt/user-data/outputs/assets/slide-visuals.manifest.json
   ```
   The manifest tool writes every deck item with `"slide_visual": true` so
   generation uses the visual-region contract instead of the generic image
   prompt path. The batch items run concurrently (bounded for API rate limits)
   and print one `IMAGEGEN_BATCH {...}` summary line. Generated images are
   written as **local files** — reference them by relative path from your slide
   HTML, never a remote URL. If the readable manifest batch runs but leaves
   failed/missing images, repair only those images serially with the same prompt
   files and output filenames. Do not switch to fully serial generation.
3. **Author one self-contained HTML file per slide** under
   `/mnt/user-data/outputs/slides/`, named so they sort in order (e.g.
   `slides/01-cover.html`, `slides/02-overview.html`). Each is a `1920×1080`
   document. Use the skeleton below. Reference the slide's image by **relative**
   path only (`../assets/01-cover.png`). A slide without a visual is allowed
   only for an explicitly text-only/no-visual deck request.
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
- **Every normal slide visual is a relative `../assets/<file>` path.** A remote
  URL in a slide is an error — generate images into `assets/` first. Slides may
  omit visuals only when the user explicitly requested a text-only/no-visual deck.
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
  slide for bounded re-authoring.

## QA Checklist

- Slides authored as `slides/*.html`; images in `assets/`, referenced relatively.
- The deck was produced by `build_deck_from_slides`, not hand-written PPTX code.
- At most one image per slide; titles/narrative/labels are real HTML text,
  legible and not clipped, never baked into the image by default.
- Explicit plain/no-image requests ship clean text-only slides; normal decks do
  not compile until generated visuals are complete.
- Expected slide count; correct primary extension `.pptx`.
- Emit promptly once the build returns a valid `.pptx`.
