---
name: ppt-generation
description: Use this skill whenever the builder must create a PowerPoint deck or presentation (.pptx). Sophia decks are authored as one self-contained HTML file per slide; the build system renders each slide and converts the deck to PPTX. You never compile the deck.
---

# Sophia Deck Skill — PPTX (HTML slides)

A deck is a set of **slide HTML files**. You author the HTML; the build system
renders each slide to a full-bleed image, checks its layout, and converts the
deck to PPTX. **You do not compile the deck yourself.** Each slide is a
self-contained `1920×1080` HTML document — real DOM text (crisp titles and body)
plus a generated image referenced by a **relative** path. This is the same
Chromium substrate the PDF report path uses.

## Building a deck

1. **Plan the slides** — slide count and, per slide: the title, the body/narrative,
   and the image to generate.
2. **Generate each slide's image into the deck `assets/` folder.** Use the
   image-generation skill in `--slide-visual` mode, writing the PNG under `/mnt/user-data/outputs/assets/`.
   Generate the hero/cover first, then the rest in ONE `--manifest` batch (each
   item referencing the hero for visual consistency):
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
   generation uses the PPTX visual-region contract instead of the generic image
   prompt path.
   Generated images are written as **local files** — reference them by relative
   path from your slide HTML, never a remote URL.
3. **Author one self-contained HTML file per slide** under
   `/mnt/user-data/outputs/slides/`, named so they sort in order (e.g.
   `slides/01-cover.html`, `slides/02-overview.html`). Each is a `1920×1080`
   document. Use the skeleton below. Reference the slide's image by **relative**
   path only (`../assets/01-cover.png`).
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
  /* A slide is exactly the deck canvas. No scroll, no margins. */
  html, body { margin: 0; padding: 0; }
  .slide {
    width: 1920px; height: 1080px; box-sizing: border-box;
    background: #0e1626; color: #f3f6fc; overflow: hidden; position: relative;
    font-family: "Helvetica Neue", Arial, sans-serif;
  }
  .slide .title { position: absolute; top: 64px; left: 80px; right: 80px;
    font-size: 64px; font-weight: 700; line-height: 1.1; }
  .slide .visual { position: absolute; top: 200px; left: 80px; right: 80px; bottom: 200px; }
  .slide .visual img { width: 100%; height: 100%; object-fit: contain; }
  .slide .narrative { position: absolute; left: 80px; right: 80px; bottom: 72px;
    font-size: 30px; line-height: 1.35; color: #aebbd2; }
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
  run `bash` to assemble a deck. The build system converts your slide HTML to PPTX.
- **Every slide visual is a relative `../assets/<file>` path.** A remote URL in a
  slide is an error — generate images into `assets/` first.
- Generate images into `/mnt/user-data/outputs/assets/`; author slides into
  `/mnt/user-data/outputs/slides/`; the deck is built to
  `/mnt/user-data/outputs/<deck>.pptx`.
- Keep visible slide text concise (title 4–9 words; narrative 1–2 sentences). The
  text is real HTML now — it renders crisply, but a wall of text still looks bad.

## QA Checklist

- Slides authored as `slides/*.html`; images in `assets/`, referenced relatively.
- The deck was produced by `build_deck_from_slides`, not hand-written PPTX code.
- One image per slide; titles/narrative are real HTML text, legible and not clipped.
- Expected slide count; correct primary extension `.pptx`.
- Emit promptly once the build returns a valid `.pptx`.
