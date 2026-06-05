import json
import os
import sys
import zipfile
from io import BytesIO

from PIL import Image
from pptx import Presentation
from pptx.util import Inches


def generate_ppt(
    plan_file: str,
    slide_images: list[str],
    output_file: str,
) -> str:
    """
    Generate a PowerPoint presentation from slide images.

    Args:
        plan_file: Path to JSON file containing presentation plan
        slide_images: List of paths to slide images in order
        output_file: Path to output PPTX file

    Returns:
        Status message
    """
    plan = load_plan(plan_file)
    if not slide_images:
        raise ValueError("No slide images were provided")

    slide_width, slide_height = slide_dimensions(plan)
    prs = Presentation()
    prs.slide_width = slide_width
    prs.slide_height = slide_height

    blank_layout = prs.slide_layouts[6]  # Blank layout
    slides_info = plan.get("slides", [])

    for i, image_path in enumerate(slide_images):
        slide = prs.slides.add_slide(blank_layout)
        add_slide_image(slide, image_path, slide_width, slide_height)
        if i < len(slides_info):
            add_speaker_notes(slide, slides_info[i])

    save_and_validate_pptx(prs, output_file)
    return f"Successfully generated presentation with {len(slide_images)} slides"


def load_plan(plan_file: str) -> dict:
    with open(plan_file, "r", encoding="utf-8") as f:
        plan = json.load(f)
    if not isinstance(plan, dict):
        raise ValueError("Invalid presentation plan: top-level JSON must be an object")
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
        nargs="+",
        required=True,
        help="Absolute paths to slide images in order (space-separated)",
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
