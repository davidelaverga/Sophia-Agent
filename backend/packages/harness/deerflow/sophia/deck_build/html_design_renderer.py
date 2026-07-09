from __future__ import annotations

import html
from pathlib import Path

from deerflow.sophia.deck_build.design_plan import design_token
from deerflow.sophia.deck_build.models import DeckBuild, DeckDesignPlan, DeckSlideSpec


def render_designed_slide_html(slide: DeckSlideSpec, deck: DeckBuild) -> str:
    plan = deck.design_plan if isinstance(deck.design_plan, DeckDesignPlan) else None
    if plan is None:
        raise ValueError("DeckBuild.design_plan is required before rendering slide HTML")
    family = (slide.composition.layout_family if slide.composition else slide.layout_kind) or "claim_native"
    has_asset = bool(slide.asset_plan and slide.asset_plan.image_gen_required)
    classes = " ".join(
        [
            "slide",
            _class_name(family),
            _class_name(deck.register),
            _class_name(plan.style_lane),
            "has_asset" if has_asset else "native_only",
        ]
    )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
{_css(plan)}
</style>
</head>
<body>
  <main class="{classes}">
    {_asset_markup(slide, family) if has_asset else ""}
    {_support_markup(slide, family, plan)}
    <section class="copy">
      <p class="section-label">{html.escape(_section_label(slide, deck))}</p>
      <h1>{html.escape(slide.title)}</h1>
      <p class="narrative">{html.escape(slide.narrative)}</p>
    </section>
    {_semantic_markup(slide, family)}
    <div class="folio">{slide.index:02d}</div>
  </main>
</body>
</html>
"""


def write_designed_slide_html(slide: DeckSlideSpec, deck: DeckBuild, host_path: Path) -> None:
    host_path.parent.mkdir(parents=True, exist_ok=True)
    host_path.write_text(render_designed_slide_html(slide, deck), encoding="utf-8")


def _css(plan: DeckDesignPlan) -> str:
    background = design_token(plan, "background", "#F5F7FA")
    surface = design_token(plan, "surface", "#FFFFFF")
    ink = design_token(plan, "ink", "#1F2937")
    muted = design_token(plan, "muted", "#526173")
    accent = design_token(plan, "accent", "#2563EB")
    support = design_token(plan, "support", "#10B981")
    width = plan.grid.slide_width_px
    height = plan.grid.slide_height_px
    display_font = _css_string(plan.typography.display)
    body_font = _css_string(plan.typography.body)
    utility_font = _css_string(plan.typography.utility or plan.typography.body)
    return f"""
html, body {{ margin: 0; padding: 0; width: {width}px; height: {height}px; background: {background}; }}
body {{ overflow: hidden; }}
.slide {{
  width: {width}px; height: {height}px; box-sizing: border-box; position: relative; overflow: hidden;
  background: {background}; color: {ink}; font-family: {body_font}, Arial, sans-serif;
}}
.copy {{ position: absolute; left: 120px; top: 86px; width: 1180px; z-index: 3; }}
h1 {{ margin: 0; font-family: {display_font}, Arial, sans-serif; font-size: 60px; line-height: 1.04; font-weight: {plan.typography.display_weight}; letter-spacing: 0; color: {ink}; }}
.narrative {{ margin: 28px 0 0; max-width: 1040px; font-size: 29px; line-height: 1.36; font-weight: {plan.typography.body_weight}; color: {muted}; }}
.section-label {{ margin: 0 0 22px; font-family: {utility_font}, Arial, sans-serif; font-size: 24px; line-height: 1; letter-spacing: 0; text-transform: uppercase; color: {accent}; }}
.folio {{ position: absolute; right: 92px; bottom: 66px; font-family: {utility_font}, Arial, sans-serif; color: {muted}; font-size: 24px; z-index: 4; }}
.rule {{ position: absolute; height: 8px; background: {accent}; z-index: 3; }}
.motif-line {{ position: absolute; background: {accent}; opacity: .82; z-index: 1; }}
.motif-line.one {{ left: 120px; bottom: 132px; width: 560px; height: 2px; }}
.motif-line.two {{ right: 130px; top: 120px; width: 2px; height: 690px; background: {support}; }}
.native-panel {{ position: absolute; box-sizing: border-box; border: 2px solid {accent}; background: {surface}; color: {ink}; z-index: 2; }}
.native-panel p, .native-panel li, .native-panel td, .native-panel th {{ font-size: 24px; line-height: 1.25; color: {ink}; }}
.asset img {{ width: 100%; height: 100%; display: block; object-fit: contain; }}
.cover_hero .asset {{ position: absolute; inset: 0; z-index: 0; }}
.cover_hero .asset img {{ object-fit: cover; }}
.cover_hero .asset::after {{ content: ""; position: absolute; inset: 0; background: {background}; opacity: .24; }}
.cover_hero .copy {{ top: 604px; width: 1280px; }}
.cover_hero h1 {{ color: {ink}; font-size: 68px; max-width: 1220px; }}
.cover_hero .narrative {{ color: {muted}; max-width: 1080px; }}
.cover_statement .copy {{ top: 210px; width: 1240px; }}
.cover_statement h1 {{ font-size: 76px; max-width: 1220px; }}
.system-diagram {{ position: absolute; left: 120px; top: 282px; width: 1680px; height: 500px; z-index: 2; }}
.system-diagram .node {{ position: absolute; width: 350px; height: 126px; border: 2px solid {accent}; background: {surface}; box-sizing: border-box; padding: 24px; }}
.system-diagram .node.a {{ left: 0; top: 120px; }}
.system-diagram .node.b {{ left: 650px; top: 40px; }}
.system-diagram .node.c {{ right: 0; top: 120px; }}
.system-diagram .connector {{ position: absolute; height: 3px; background: {accent}; top: 184px; left: 350px; width: 980px; }}
.flow {{ position: absolute; left: 120px; top: 300px; width: 1680px; height: 430px; z-index: 2; }}
.flow li {{ position: relative; display: inline-block; vertical-align: top; width: 330px; min-height: 170px; margin-right: 72px; padding: 28px; list-style: none; background: {surface}; border-top: 8px solid {accent}; color: {ink}; font-size: 24px; line-height: 1.26; }}
.comparison-table {{ position: absolute; left: 120px; top: 270px; width: 1680px; border-collapse: collapse; z-index: 2; }}
.comparison-table th, .comparison-table td {{ border: 2px solid {accent}; padding: 26px 32px; font-size: 25px; line-height: 1.28; background: {surface}; color: {ink}; }}
.comparison-table th {{ color: {accent}; font-family: {utility_font}, Arial, sans-serif; text-align: left; }}
.evidence-panel {{ position: absolute; left: 120px; top: 300px; width: 710px; min-height: 330px; padding: 34px; background: {surface}; border-left: 10px solid {support}; z-index: 2; }}
.evidence-panel p {{ font-size: 30px; line-height: 1.28; margin: 0; color: {ink}; }}
.closing-synthesis {{ position: absolute; right: 180px; top: 212px; width: 520px; height: 520px; border-radius: 50%; border: 8px solid {accent}; box-sizing: border-box; z-index: 1; }}
.closing_synthesis .copy {{ top: 240px; width: 1020px; }}
.split_asset .copy {{ width: 760px; top: 135px; }}
.split_asset .asset {{ position: absolute; left: 990px; top: 190px; width: 780px; height: 620px; border: 2px solid {accent}; background: {surface}; z-index: 2; }}
.split_asset .asset img {{ object-fit: contain; }}
.asset figcaption {{ position: absolute; left: 18px; bottom: 14px; color: {muted}; font-size: 24px; font-family: {utility_font}, Arial, sans-serif; }}
.claim_native .system-diagram, .cover_statement .system-diagram, .closing_synthesis .system-diagram {{ display: none; }}
"""


def _asset_markup(slide: DeckSlideSpec, family: str) -> str:
    fit = (slide.asset_plan.fit if slide.asset_plan else "contain") or "contain"
    asset_class = "asset"
    src = f"../assets/slide-{slide.index:02d}.png"
    if family == "cover_hero":
        return f'<figure class="{asset_class}"><img src="{src}" alt="" style="object-fit: cover;"></figure>'
    object_fit = "cover" if fit in {"cover", "crop_safe_cover", "full_bleed"} else "contain"
    return (
        f'<figure class="{asset_class}"><img src="{src}" alt="" style="object-fit: {object_fit};">'
        "<figcaption>Generated asset, not slide text</figcaption></figure>"
    )


def _support_markup(slide: DeckSlideSpec, family: str, plan: DeckDesignPlan) -> str:
    del slide, plan
    if family == "cover_hero":
        return '<div class="rule" style="left:126px;top:584px;width:180px;"></div><div class="motif-line one"></div><div class="motif-line two"></div>'
    if family == "cover_statement":
        return '<div class="motif-line one"></div><div class="motif-line two"></div>'
    return '<div class="motif-line one"></div>'


def _semantic_markup(slide: DeckSlideSpec, family: str) -> str:
    phrases = _phrases(slide)
    if family in {"system_diagram", "claim_native"}:
        return f"""
    <section class="system-diagram" aria-label="Native system diagram">
      <div class="connector"></div>
      <div class="node a native-panel"><p>{html.escape(phrases[0])}</p></div>
      <div class="node b native-panel"><p>{html.escape(phrases[1])}</p></div>
      <div class="node c native-panel"><p>{html.escape(phrases[2])}</p></div>
    </section>"""
    if family == "process_flow":
        return f"""
    <ul class="flow" aria-label="Native process flow">
      <li>{html.escape(phrases[0])}</li>
      <li>{html.escape(phrases[1])}</li>
      <li>{html.escape(phrases[2])}</li>
      <li>{html.escape(phrases[3])}</li>
    </ul>"""
    if family == "comparison_matrix":
        return f"""
    <table class="comparison-table">
      <tr><th>Before</th><th>After</th></tr>
      <tr><td>{html.escape(phrases[0])}</td><td>{html.escape(phrases[1])}</td></tr>
      <tr><td>{html.escape(phrases[2])}</td><td>{html.escape(phrases[3])}</td></tr>
    </table>"""
    if family == "evidence_callout":
        return f'<aside class="evidence-panel"><p>{html.escape(slide.claim or phrases[0])}</p></aside>'
    if family == "closing_synthesis":
        return '<div class="closing-synthesis" aria-hidden="true"></div>'
    return ""


def _phrases(slide: DeckSlideSpec) -> list[str]:
    words = [part.strip(" .,;:") for part in slide.narrative.split() if part.strip(" .,;:")]
    if not words:
        words = [slide.title]
    chunks: list[str] = []
    for offset in range(0, min(len(words), 24), 6):
        chunks.append(" ".join(words[offset : offset + 6]))
    while len(chunks) < 4:
        chunks.append(slide.title)
    return [chunk[:72] for chunk in chunks[:4]]


def _section_label(slide: DeckSlideSpec, deck: DeckBuild) -> str:
    role = str(slide.role or "slide").replace("_", " ")
    return f"{deck.deck_title} / {role}"


def _class_name(value: str) -> str:
    clean = "".join(ch if ch.isalnum() else "_" for ch in str(value or "").lower()).strip("_")
    return clean or "slide"


def _css_string(value: str) -> str:
    clean = str(value or "Arial").replace('"', "").replace(";", "").strip()
    return f'"{clean}"'
