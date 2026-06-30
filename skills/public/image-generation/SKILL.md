---
name: image-generation
description: Use this skill when the user requests to generate, create, imagine, or visualize images including characters, scenes, products, or any visual content. Supports structured prompts and reference images for guided generation.
---

# Image Generation Skill

## Overview

This skill generates high-quality images using structured prompts and a Python script backed by OpenAI image models. Fresh generations use `gpt-image-2`; reference-conditioned edits use `gpt-image-2` with reference images sent through `client.images.edit`. The workflow includes creating JSON-formatted prompts and executing image generation with optional reference images.

## Core Capabilities

- Create structured JSON prompts for AIGC image generation
- Support multiple reference images for style/composition guidance
- Generate images through automated Python script execution
- Handle various image generation scenarios (character design, scenes, products, etc.)

## Workflow

### Step 1: Understand Requirements

When a user requests image generation, identify:

- Subject/content: What should be in the image
- Style preferences: Art style, mood, color palette
- Technical specs: Aspect ratio, composition, lighting
- Reference images: Any images to guide generation
- You don't need to check the folder under `/mnt/user-data`

### Step 2: Create Structured Prompt

Generate a structured JSON file in `/mnt/user-data/workspace/` with naming pattern: `{descriptive-name}.json`

### Step 3: Execute Generation

Call the Python script. It requires `OPENAI_API_KEY` in the builder/LangGraph environment and exits non-zero if the key is missing, the OpenAI request fails, reference images are invalid, or no image bytes land on disk. Calls without `--reference-images` use `gpt-image-2` through `client.images.generate`; calls with references use `gpt-image-2` through `client.images.edit`:
```bash
python /mnt/skills/public/image-generation/scripts/generate.py \
  --prompt-file /mnt/user-data/workspace/prompt-file.json \
  --reference-images /path/to/ref1.jpg /path/to/ref2.png \
  --output-file /mnt/user-data/outputs/generated-image.jpg
  --aspect-ratio 16:9
```

Parameters:

- `--prompt-file`: Absolute path to JSON prompt file (required)
- `--reference-images`: Absolute paths to reference images (optional, space-separated)
- `--output-file`: Absolute path to output image file (required)
- `--aspect-ratio`: Aspect ratio of the generated image (optional, default: 16:9)
- `--slide-visual`: PPTX slide VISUAL-ONLY mode (quality=high, 16:9; optional) — generates the visual area only, never the title/narrative/chrome

[!NOTE]
Do NOT read the python file, just call it with the parameters.

## Character Generation Example

User request: "Create a Tokyo street style woman character in 1990s"

Create prompt file: `/mnt/user-data/workspace/asian-woman.json`
```json
{
  "characters": [{
    "gender": "female",
    "age": "mid-20s",
    "ethnicity": "Japanese",
    "body_type": "slender, elegant",
    "facial_features": "delicate features, expressive eyes, subtle makeup with emphasis on lips, long dark hair partially wet from rain",
    "clothing": "stylish trench coat, designer handbag, high heels, contemporary Tokyo street fashion",
    "accessories": "minimal jewelry, statement earrings, leather handbag",
    "era": "1990s"
  }],
  "style": "Leica M11 street photography aesthetic, film-like rendering, natural color palette with slight warmth, bokeh background blur, analog photography feel",
  "composition": "medium shot, rule of thirds, subject slightly off-center, environmental context of Tokyo street visible, shallow depth of field isolating subject",
  "lighting": "neon lights from signs and storefronts, wet pavement reflections, soft ambient city glow, natural street lighting, rim lighting from background neons",
  "color_palette": "muted naturalistic tones, warm skin tones, cool blue and magenta neon accents, desaturated compared to digital photography, film grain texture"
}
```

Execute generation:
```bash
python /mnt/skills/public/image-generation/scripts/generate.py \
  --prompt-file /mnt/user-data/workspace/cyberpunk-hacker.json \
  --output-file /mnt/user-data/outputs/cyberpunk-hacker-01.jpg \
  --aspect-ratio 2:3
```

With reference images:
```json
{
  "characters": [{
    "gender": "based on [Image 1]",
    "age": "based on [Image 1]",
    "ethnicity": "human from [Image 1] adapted to Star Wars universe",
    "body_type": "based on [Image 1]",
    "facial_features": "matching [Image 1] with slight weathered look from space travel",
    "clothing": "Star Wars style outfit - worn leather jacket with utility vest, cargo pants with tactical pouches, scuffed boots, belt with holster",
    "accessories": "blaster pistol on hip, comlink device on wrist, goggles pushed up on forehead, satchel with supplies, personal vehicle based on [Image 2]",
    "era": "Star Wars universe, post-Empire era"
  }],
  "prompt": "Character inspired by [Image 1] standing next to a vehicle inspired by [Image 2] on a bustling alien planet street in Star Wars universe aesthetic. Character wearing worn leather jacket with utility vest, cargo pants with tactical pouches, scuffed boots, belt with blaster holster. The vehicle adapted to Star Wars aesthetic with weathered metal panels, repulsor engines, desert dust covering, parked on the street. Exotic alien marketplace street with multi-level architecture, weathered metal structures, hanging market stalls with colorful awnings, alien species walking by as background characters. Twin suns casting warm golden light, atmospheric dust particles in air, moisture vaporators visible in distance. Gritty lived-in Star Wars aesthetic, practical effects look, film grain texture, cinematic composition.",
  "style": "Star Wars original trilogy aesthetic, lived-in universe, practical effects inspired, cinematic film look, slightly desaturated with warm tones",
  "composition": "medium wide shot, character in foreground with alien street extending into background, environmental storytelling, rule of thirds",
  "lighting": "warm golden hour lighting from twin suns, rim lighting on character, atmospheric haze, practical light sources from market stalls",
  "color_palette": "warm sandy tones, ochre and sienna, dusty blues, weathered metals, muted earth colors with pops of alien market colors",
  "technical": {
    "aspect_ratio": "9:16",
    "quality": "high",
    "detail_level": "highly detailed with film-like texture"
  }
}
```
```bash
python /mnt/skills/public/image-generation/scripts/generate.py \
  --prompt-file /mnt/user-data/workspace/star-wars-scene.json \
  --reference-images /mnt/user-data/uploads/character-ref.jpg /mnt/user-data/uploads/vehicle-ref.jpg \
  --output-file /mnt/user-data/outputs/star-wars-scene-01.jpg \
  --aspect-ratio 16:9
```

## Two modes

1. **Slide visual assets (`--slide-visual`)** — for `.pptx` slides, this skill renders the
   image that goes inside the `ppt-generation` HTML skeleton's `.visual` region. Do NOT bake
   the slide title, bottom narrative, footer, or page chrome into this PNG; those are real
   HTML text in `slides/*.html`. Use `--slide-visual` (quality=high, 16:9) for the visual
   substance only: diagrams, architecture maps, comparison panels, scenes, charts, or
   conceptual illustrations. Diagram labels inside the visual are allowed when essential;
   wrap required label copy as "THE TEXT READS: ...", keep labels 8 words or fewer, and keep
   them away from the image edges so the HTML title/narrative never overlap the asset.
   Pass the first slide as `--reference-images` to later slides for consistency; the script
   automatically sends those referenced slides through the `gpt-image-2` edit path.

2. **Illustrations (default)** — standalone images, heroes, section art, and concept
   illustrations. Describe only the subject; NO text, labels, charts, or diagrams in the image.

### Batch generation (decks) — generate in parallel, not one per turn

For multi-image decks, do NOT call the script once per slide across turns (that serializes
~2 min/image). Instead:

1. Generate the hero/cover image first with a single `--slide-visual` call.
2. Write ONE JSON manifest of all remaining slide images and call the script once with
   `--manifest`. Give every item the hero PNG in `reference_images` so the deck stays consistent:

```json
{"items": [
  {"prompt_file": "/mnt/user-data/workspace/slide-02.json",
   "output_file": "/mnt/user-data/outputs/assets/slide-02.png",
   "slide_visual": true,
   "reference_images": ["/mnt/user-data/outputs/assets/hero.png"]},
  {"prompt_file": "/mnt/user-data/workspace/slide-03.json",
   "output_file": "/mnt/user-data/outputs/assets/slide-03.png",
   "slide_visual": true,
   "reference_images": ["/mnt/user-data/outputs/assets/hero.png"]}
]}
```
```bash
python /mnt/skills/public/image-generation/scripts/generate.py \
  --manifest /mnt/user-data/outputs/assets/slide-manifest.json
```

**Write the manifest in its own `write_file` call FIRST, then run `--manifest`
in a SEPARATE bash call.** The harness reads the manifest from disk at dispatch
to count images against the budget — a manifest written and run in the same
`&&`-chained command does not exist yet at that check and is rejected. One
`write_file` (the JSON), then one `bash` (`--manifest <path>`).

Deck slide assets live under `/mnt/user-data/outputs/assets/`; the slide HTML
references them by a relative `../assets/<file>` path (see the `ppt-generation`
skill). The slide title and narrative are real HTML text — never baked into the
image.

If image generation keeps failing or being rejected, do NOT keep retrying it.
Author the slides with whatever images already exist in `assets/` and call
`build_deck_from_slides` — missing visuals become clean placeholders and the
deck still ships (a complete deck beats one that never finishes).

The items run concurrently (bounded for API rate limits); the script prints one
`IMAGEGEN_BATCH {...}` summary line with per-image success. A failed item is isolated and never
aborts the batch.

For PDF reports, do NOT use this image skill for data charts or structural diagrams. The PDF
workflow authors those figures as inline static `<svg>` inside one self-contained HTML file and
renders the PDF with `render_html_to_pdf`; there is no remote chart tool in the report path.
You may use this image skill for up to **3 conceptual/editorial illustrations per report** (a
cover/hero plus key concepts): subject-only prompts, no text baked into the image,
theme-matched palette. Reserve generated images for conceptual/aesthetic figures only.

Reference library: for Excalidraw-style technical slide visuals, first inspect
`/mnt/skills/public/image-generation/references/manifest.json`. It is a v2 style manifest:
choose one `visual_style` for the whole deck, use the matching `prompt_anchor` in every slide
prompt, and vary `diagram_type` within that style. Pass a seed image with `--reference-images`
only when the chosen style lists a real ref for the target diagram type. If the chosen style has
no ref for that type, do not invent a path; rely on the text prompt anchor.

- nested-container architecture -> `architecture_nested`
- comparison panels -> `comparison_panels` or `two_panel_comparison`
- swimlane / staged process -> `process_guards`
- conceptual loop/metaphor -> `experiment_loop`

The reference sets the look; the prompt still supplies the exact structure, labels, brand
palette, and "THE TEXT READS: ..." strings. Keep one visual style per deck.

Before accepting a presentation slide visual, check hierarchy, specificity, restraint, and
variety. Reject purple/pink generic hero slides, single-font template looks, and stock-deck
styling even if the image was generated successfully.

## Common Scenarios

Use different JSON schemas for different scenarios.

**Character Design**:
- Physical attributes (gender, age, ethnicity, body type)
- Facial features and expressions
- Clothing and accessories
- Historical era or setting
- Pose and context

**Scene Generation**:
- Environment description
- Time of day, weather
- Mood and atmosphere
- Focal points and composition

**Product Visualization**:
- Product details and materials
- Lighting setup
- Background and context
- Presentation angle

## Specific Templates

Read the following template file only when matching the user request.

- [Doraemon Comic](templates/doraemon.md)

## Output Handling

After generation:

- Images are typically saved in `/mnt/user-data/outputs/`
- Share generated images with user using present_files tool
- Provide brief description of the generation result
- Offer to iterate if adjustments needed

## Tips: Enhancing Generation with Reference Images

For scenarios where visual accuracy is critical, **use the `image_search` tool first** to find reference images before generation.

**Recommended scenarios for using image_search tool:**
- **Character/Portrait Generation**: Search for similar poses, expressions, or styles to guide facial features and body proportions
- **Specific Objects or Products**: Find reference images of real objects to ensure accurate representation
- **Architectural or Environmental Scenes**: Search for location references to capture authentic details
- **Fashion and Clothing**: Find style references to ensure accurate garment details and styling

**Example workflow:**
1. Call the `image_search` tool to find suitable reference images:
   ```
   image_search(query="Japanese woman street photography 1990s", size="Large")
   ```
2. Download the returned image URLs to local files
3. Use the downloaded images as `--reference-images` parameter in the generation script

This approach significantly improves generation quality by providing the model with concrete visual guidance rather than relying solely on text descriptions.

## Notes

- Always use English for prompts regardless of user's language
- JSON format ensures structured, parsable prompts
- Reference images enhance generation quality significantly
- Iterative refinement is normal for optimal results
- For character generation, include the detailed character object plus a consolidated prompt field
