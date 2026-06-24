---
name: ppt-generation
description: Use this skill whenever the builder must create a PowerPoint deck or presentation (.pptx). Sophia decks are pure image-forward: one generated full-slide bitmap per slide, compiled into PPTX with speaker notes only.
---

# Sophia Deck Skill - PPTX

Sophia presentations are generated visual decks, not editable template decks.
Every slide is a single 16:9 image with all visible title, concise narrative,
labels, diagrams, and layout baked into the bitmap. The PPTX compiler places that image
full bleed and attaches speaker notes. It does not draw compiler-side titles,
captions, charts, shapes, or engine-composed slides.

## Workflow

1. Plan the deck: one line per slide with `title`, core idea, treatment,
   diagram family, and visible bottom narrative.
2. Choose one `visual_style` for the whole deck from the image-generation
   manifest. Keep the style consistent while varying composition and diagram
   grammar.
3. Generate one PNG per slide with the image-generation script in slide-visual
   mode.
4. QC each slide image. Repair/regenerate once when required.
5. Create a plan JSON whose slides point to the generated images with
   `image_path` and include concise `speaker_notes`.
6. Compile the PPTX. Emit the `.pptx` as the primary artifact.

## Slide Image Contract

Every prompt must ask for:

- A professional presentation slide, 16:9.
- top 14% title band.
- Center 70% visual safe area.
- bottom 16% narrative band for content, architecture, process,
  comparison, and concept slides.
- No visual element entering the top or bottom bands.
- Exact rendered strings for every visible label.

Use this prompt skeleton:

```text
A professional presentation slide, 16:9.
Reserve the top 14% for title, bottom 16% for a concise 1-2 sentence narrative, and center 70% for the visual.
Title band text: "{title}".
Bottom narrative band text: "{narrative}".
Center safe area: {precise layout and visual description}.
Labels to render exactly: "{label 1}", "{label 2}", ...
Use the selected Sophia visual style: {visual_style}. High contrast, crisp, presentation-grade.
```

Keep visible text concise:

- Title: 4-9 words.
- Bottom narrative: 1-2 short sentences that explain the slide's point, ideally 18-34 words total.
- Diagram labels: 1-5 words each.
- Avoid dense paragraphs on the slide image.

## Narrative

Speaker notes are required for content slides. Notes should be 1-3 concise
sentences that narrate the slide. Notes are not visible on the slide and do not
replace the bottom narrative band.

## Hard Data

When exact numeric reading is essential, include the exact data in the image
prompt and keep the chart simple. Do not fabricate values. If the data cannot
be rendered reliably after one repair, emit an honest warning rather than
switching to an engine-composed PPTX slide.

## Compile Contract

The plan JSON must include one image path per slide:

```json
{
  "title": "Deck title",
  "slides": [
    {
      "title": "Slide title",
      "image_path": "/mnt/user-data/outputs/visuals/slide-01.png",
      "speaker_notes": "Concise narration."
    }
  ]
}
```

Compile with the PPTX workflow. The compiler fails if a slide image is missing.
That failure is intentional: regenerate the missing image or stop cleanly.

## QA Checklist

- One picture per slide.
- Zero compiler-side text boxes over image-forward slides.
- Baked title visible on every slide.
- Baked 1-2 sentence narrative visible on content slides.
- No overlap between title, center visual, and bottom narrative.
- Expected slide count.
- Correct primary extension: `.pptx`.
- Emit promptly once valid.
