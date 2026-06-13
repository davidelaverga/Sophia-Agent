---
name: ppt-generation
description: Use this skill when the user requests presentations, slide decks, PowerPoint, PPT, or PPTX files. It creates editable PowerPoint decks from a structured plan, local visuals, optional generated imagery, and a validated PPTX compiler.
---

# PPT Generation Skill

## Purpose

Create a real, editable `.pptx` presentation. The final deck should contain
PowerPoint text, layouts, charts, diagrams, and images as slide elements. Do
not deliver a folder of images or a deck made only of full-slide screenshots.

This skill is inspired by MIT-safe presentation-generation patterns. The
compiler and quality gates are Sophia-owned; do not write ad hoc
`python-pptx` scripts unless this skill's compiler is unavailable and the
fallback is explicitly reported.

## Workflow

1. Plan the deck with `write_todos`, including requested slide count, audience,
   narrative arc, and what each slide must prove.
2. Create a structured plan JSON under `/mnt/user-data/workspace/`. Include:
   `title`, `theme`, optional `motif`, and `slides`.
3. For normal decks, use a polished visual treatment unless the user clearly
   asks for plain, text-only, or no-visual slides.
4. Use the right visual source:
   - Numeric charts: use chart/data guidance and local PNG/SVG assets.
   - Technical diagrams: use `generate_excalidraw_diagram`.
   - Illustrative hero/section visuals: use `image-generation` when helpful.
5. Reference local PNG/JPEG assets from slide fields `image`, `chart_path`, or
   `visual_path`. Generated images are slide assets, not entire slide canvases.
6. Run the compiler:

```bash
python /mnt/skills/public/ppt-generation/scripts/generate.py \
  --plan-file /mnt/user-data/workspace/presentation-plan.json \
  --output-file /mnt/user-data/outputs/presentation.pptx
```

If you generated a small number of hero/section images, you may pass them with
`--slide-images`, but the compiler will still render editable titles, body
text, notes, and layouts over/alongside those images:

```bash
python /mnt/skills/public/ppt-generation/scripts/generate.py \
  --plan-file /mnt/user-data/workspace/presentation-plan.json \
  --slide-images /mnt/user-data/outputs/slide-01-hero.jpg /mnt/user-data/outputs/slide-03-diagram.jpg \
  --output-file /mnt/user-data/outputs/presentation.pptx
```

7. Emit only after the `.pptx` exists and passes structural validation.

## Plan JSON

Use this compact schema:

```json
{
  "title": "Presentation Title",
  "theme": "boardroom",
  "motif": "rule",
  "aspect_ratio": "16:9",
  "slides": [
    {
      "slide_number": 1,
      "layout": "title",
      "title": "Main Title",
      "subtitle": "Subtitle"
    },
    {
      "slide_number": 2,
      "layout": "content_image",
      "title": "Why It Matters",
      "key_points": ["Concrete point", "Evidence point", "Implication"],
      "image": "/mnt/user-data/outputs/visuals/system-map.png"
    },
    {
      "slide_number": 3,
      "layout": "two_column",
      "title": "Trade-offs",
      "columns": [
        {"heading": "Current", "points": ["Constraint", "Risk"]},
        {"heading": "Future", "points": ["Capability", "Benefit"]}
      ]
    }
  ]
}
```

Supported `theme`: `boardroom`, `daylight`, `ember`, `mist`, `terra`, `noir`.

Supported `layout`: `title`, `content_text`, `content_image`,
`full_bleed_image`, `section_divider`, `quote`, `two_column`, `stat_band`,
`closing`.

## Quality Rules

- A normal deck must include editable text. A deck where every slide is just
  an image is not acceptable.
- Every slide needs a clear job: setup, evidence, explanation, comparison,
  transition, or conclusion.
- For charts/diagrams, prefer meaningful local assets with labels, legends,
  and context. Do not use decorative placeholder visuals.
- Use generated imagery for polish, mood, covers, section openers, or
  illustrative scenes. Do not depend on it for factual diagrams or charts.
- If image generation fails, continue with chart/diagram/text layouts instead
  of looping or falling back immediately.

## Failure And Fallback

A valid `.pptx` always wins. If deck compilation or validation fails after
one correction and you have a real `.html` or `.md` user-facing fallback, emit
it only with:

- `requested_artifact_ext="pptx"`
- `artifact_is_fallback=true`
- `fallback_reason="pptx_generation_not_completed"`

Never emit PNG support assets, helper scripts, corrupt/tiny PPTX files, or
plain HTML/Markdown as normal slide-deck success.
