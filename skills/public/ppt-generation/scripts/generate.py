import json
import os
import sys
import zipfile
from io import BytesIO

from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches, Pt


def generate_ppt(
    plan_file: str,
    slide_images: list[str],
    output_file: str,
) -> str:
    """
    Generate a PowerPoint presentation from a plan, optionally with slide images.

    Args:
        plan_file: Path to JSON file containing presentation plan
        slide_images: Optional list of paths to slide images in order
        output_file: Path to output PPTX file

    Returns:
        Status message
    """
    plan = load_plan(plan_file)
    slide_width, slide_height = slide_dimensions(plan)
    prs = Presentation()
    prs.slide_width = slide_width
    prs.slide_height = slide_height

    blank_layout = prs.slide_layouts[6]  # Blank layout
    slides_info = plan.get("slides", [])
    if not slides_info:
        slides_info = [{"slide_number": 1, "type": "title", "title": plan.get("title", "Presentation")}]

    if slide_images:
        for i, image_path in enumerate(slide_images):
            slide = prs.slides.add_slide(blank_layout)
            add_slide_image(slide, image_path, slide_width, slide_height)
            if i < len(slides_info):
                add_speaker_notes(slide, slides_info[i])
    else:
        for slide_info in slides_info:
            slide = prs.slides.add_slide(blank_layout)
            add_text_layout_slide(slide, slide_info, plan)
            add_speaker_notes(slide, slide_info)

    save_and_validate_pptx(prs, output_file)
    return f"Successfully generated presentation with {len(prs.slides)} slides"


def add_text_layout_slide(slide, slide_info: dict, plan: dict) -> None:
    style = str(plan.get("style") or "business")
    title = str(slide_info.get("title") or plan.get("title") or "Untitled")
    subtitle = str(slide_info.get("subtitle") or "")
    points = slide_points(slide_info)
    dark = style in {"dark-premium", "keynote", "glassmorphism"}
    bg = slide.background.fill
    bg.solid()
    bg.fore_color.rgb = RGBColor(10, 10, 14) if dark else RGBColor(248, 250, 252)
    title_color = RGBColor(248, 250, 252) if dark else RGBColor(18, 24, 38)
    body_color = RGBColor(216, 222, 235) if dark else RGBColor(45, 55, 72)
    accent = RGBColor(124, 92, 255) if dark else RGBColor(28, 126, 214)

    title_box = slide.shapes.add_textbox(Inches(0.7), Inches(0.55), Inches(12), Inches(1.05))
    title_frame = title_box.text_frame
    title_frame.clear()
    p = title_frame.paragraphs[0]
    p.text = title
    p.font.bold = True
    p.font.size = Pt(34 if len(title) < 50 else 28)
    p.font.color.rgb = title_color

    if subtitle:
        subtitle_box = slide.shapes.add_textbox(Inches(0.75), Inches(1.55), Inches(11.6), Inches(0.55))
        subtitle_frame = subtitle_box.text_frame
        subtitle_frame.clear()
        p = subtitle_frame.paragraphs[0]
        p.text = subtitle
        p.font.size = Pt(17)
        p.font.color.rgb = body_color

    accent_bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.75), Inches(2.25), Inches(0.08), Inches(4.35))
    accent_bar.fill.solid()
    accent_bar.fill.fore_color.rgb = accent
    accent_bar.line.color.rgb = accent
    body_box = slide.shapes.add_textbox(Inches(1.05), Inches(2.2), Inches(11.2), Inches(4.6))
    body_frame = body_box.text_frame
    body_frame.word_wrap = True
    body_frame.clear()
    if not points:
        points = [str(slide_info.get("summary") or slide_info.get("body") or "")]
    for idx, point in enumerate(points[:6]):
        paragraph = body_frame.paragraphs[0] if idx == 0 else body_frame.add_paragraph()
        paragraph.text = str(point)
        paragraph.level = 0
        paragraph.font.size = Pt(20 if len(points) <= 4 else 17)
        paragraph.font.color.rgb = body_color
        paragraph.space_after = Pt(8)


def slide_points(slide_info: dict) -> list[str]:
    for key in ("key_points", "bullets", "points"):
        value = slide_info.get(key)
        if isinstance(value, list):
            return [str(item) for item in value if str(item).strip()]
    return []


def load_plan(plan_file: str) -> dict:
    with open(plan_file, encoding="utf-8") as f:
        plan = json.load(f)
    if not isinstance(plan, dict):
        raise ValueError("Invalid presentation plan: top-level JSON must be an object")
    slides = plan.get("slides")
    if slides is not None and not isinstance(slides, list):
        raise ValueError("Invalid presentation plan: slides must be a list")
    if isinstance(slides, list):
        for index, slide in enumerate(slides, start=1):
            if not isinstance(slide, dict):
                raise ValueError(f"Invalid presentation plan: slide {index} must be an object")
    return plan


def slide_dimensions(plan: dict):
    aspect_ratio = plan.get("aspect_ratio", "16:9")
    if aspect_ratio == "4:3":
        return Inches(10), Inches(7.5)
    return Inches(13.333), Inches(7.5)


def add_slide_image(slide, image_path: str, slide_width, slide_height) -> None:
    if not os.path.exists(image_path):
        raise FileNotFoundError("Slide image not found")
    with Image.open(image_path) as img:
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        img_bytes, left, top, width, height = fitted_image_payload(
            img,
            slide_width,
            slide_height,
        )
        slide.shapes.add_picture(img_bytes, left, top, width, height)


def fitted_image_payload(img, slide_width, slide_height):
    img_width, img_height = img.size
    img_aspect = img_width / img_height
    slide_width_emu = int(slide_width)
    slide_height_emu = int(slide_height)
    slide_aspect = slide_width / slide_height
    if img_aspect > slide_aspect:
        new_width_emu = slide_width_emu
        new_height_emu = int(slide_width_emu / img_aspect)
        left = Inches(0)
        top = Inches((slide_height_emu - new_height_emu) / 914400)
    else:
        new_height_emu = slide_height_emu
        new_width_emu = int(slide_height_emu * img_aspect)
        left = Inches((slide_width_emu - new_width_emu) / 914400)
        top = Inches(0)
    img_bytes = BytesIO()
    img.save(img_bytes, format="JPEG", quality=95)
    img_bytes.seek(0)
    return img_bytes, left, top, Inches(new_width_emu / 914400), Inches(new_height_emu / 914400)


def add_speaker_notes(slide, slide_info) -> None:
    notes = speaker_notes(slide_info)
    if not notes:
        return
    text_frame = slide.notes_slide.notes_text_frame
    if text_frame is not None:
        text_frame.text = "\n".join(notes)


def speaker_notes(slide_info) -> list[str]:
    notes = []
    if slide_info.get("title"):
        notes.append(f"Title: {slide_info['title']}")
    if slide_info.get("subtitle"):
        notes.append(f"Subtitle: {slide_info['subtitle']}")
    if slide_info.get("key_points"):
        notes.append("Key Points:")
        notes.extend(f"  • {point}" for point in slide_info["key_points"])
    return notes


def save_and_validate_pptx(prs, output_file: str) -> None:
    os.makedirs(os.path.dirname(output_file) or ".", exist_ok=True)
    prs.save(output_file)
    if not os.path.exists(output_file) or os.path.getsize(output_file) <= 0:
        raise RuntimeError("PPTX save did not produce output bytes")
    with zipfile.ZipFile(output_file, "r") as archive:
        names = set(archive.namelist())
    required = {"[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"}
    missing = sorted(required.difference(names))
    if missing:
        raise RuntimeError(f"PPTX save missing required Office entries: {','.join(missing)}")


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(
        description="Generate PowerPoint presentation from slide images"
    )
    parser.add_argument(
        "--plan-file",
        required=True,
        help="Absolute path to JSON presentation plan file",
    )
    parser.add_argument(
        "--slide-images",
        nargs="*",
        default=[],
        help="Optional absolute paths to slide images in order (space-separated)",
    )
    parser.add_argument(
        "--output-file",
        required=True,
        help="Output path for generated PPTX file",
    )

    args = parser.parse_args()

    try:
        message = generate_ppt(
            args.plan_file,
            args.slide_images,
            args.output_file,
        )
        size = os.path.getsize(args.output_file)
        print(message)
        print(
            "PPT generation diagnostics: "
            f"slide_count={len(args.slide_images)} output_ext=.pptx bytes={size}",
            file=sys.stderr,
        )
        return 0
    except Exception as e:
        print(
            f"Error while generating presentation: {type(e).__name__}: {e}",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
