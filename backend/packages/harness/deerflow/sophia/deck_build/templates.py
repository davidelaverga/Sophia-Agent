from __future__ import annotations

import html
import re
from pathlib import Path

from deerflow.sophia.deck_build.models import DeckBuild, DeckSlideSpec

_OUTPUTS = "/mnt/user-data/outputs/"
_SLIDES = f"{_OUTPUTS}slides"


def slugify(value: str, fallback: str = "slide") -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or fallback


def slide_html_virtual_path(slide: DeckSlideSpec) -> str:
    return f"{_SLIDES}/{slide.index:02d}-{slugify(slide.role or slide.title)}.html"


def render_slide_html(slide: DeckSlideSpec, deck: DeckBuild) -> str:
    title = html.escape(slide.title)
    narrative = html.escape(slide.narrative)
    visual = ""
    visual_class = "visual"
    visual_state_class = "no_visual"
    if deck.visual_policy == "required":
        visual = f'<div class="{visual_class}"><img src="../assets/slide-{slide.index:02d}.png" alt=""></div>'
        visual_state_class = "has_visual"
    layout_class = html.escape(slide.layout_kind or "single_visual_focus")
    register_class = html.escape(deck.register or "professional_technical")
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
html, body {{ margin: 0; padding: 0; width: 1920px; height: 1080px; background: #f7f9fc; }}
.slide {{
  width: 1920px; height: 1080px; box-sizing: border-box; overflow: hidden; position: relative;
  background: #f7f9fc; color: #1f2a37; font-family: "Helvetica Neue", Arial, sans-serif;
}}
.title {{ position: absolute; top: 64px; left: 80px; right: 80px; font-size: 58px; line-height: 1.08; font-weight: 720; }}
.narrative {{ position: absolute; left: 80px; right: 80px; bottom: 68px; color: #405066; font-size: 30px; line-height: 1.35; }}
.visual {{ position: absolute; top: 190px; left: 80px; right: 80px; bottom: 190px; display: flex; align-items: center; justify-content: center; }}
.visual img {{ width: 100%; height: 100%; object-fit: cover; display: block; }}
.visual_left_text_right .visual {{ top: 220px; left: 80px; right: 820px; bottom: 150px; }}
.visual_left_text_right .narrative {{ left: 1180px; right: 80px; top: 250px; bottom: auto; font-size: 34px; }}
.text_left_visual_right .visual {{ top: 220px; left: 820px; right: 80px; bottom: 150px; }}
.text_left_visual_right .narrative {{ left: 80px; right: 1180px; top: 250px; bottom: auto; font-size: 34px; }}
.cover_hero .visual {{ inset: 0; opacity: 0.92; }}
.cover_hero.has_visual .title {{ top: 650px; color: #ffffff; text-shadow: 0 8px 22px rgba(0,0,0,.35); }}
.cover_hero.has_visual .narrative {{ color: #eef4fb; text-shadow: 0 5px 18px rgba(0,0,0,.35); }}
.comparison_two_column .visual, .timeline_flow .visual, .single_visual_focus .visual {{ object-fit: cover; }}
</style>
</head>
<body>
  <main class="slide {layout_class} {register_class} {visual_state_class}">
    {visual}
    <div class="title">{title}</div>
    <div class="narrative">{narrative}</div>
  </main>
</body>
</html>
"""


def write_slide_html(slide: DeckSlideSpec, deck: DeckBuild, host_path: Path) -> None:
    host_path.parent.mkdir(parents=True, exist_ok=True)
    host_path.write_text(render_slide_html(slide, deck), encoding="utf-8")
