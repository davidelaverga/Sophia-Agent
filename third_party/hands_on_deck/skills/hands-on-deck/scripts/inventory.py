#!/usr/bin/env python3
"""
Extract structured text content from PowerPoint presentations.

This module provides functionality to:
- Extract all text content from PowerPoint shapes
- Preserve paragraph formatting (alignment, bullets, fonts, spacing)
- Handle nested GroupShapes recursively with correct absolute positions
- Sort shapes by visual position on slides
- Filter out slide numbers and non-content placeholders
- Export to JSON with clean, structured data

Classes:
    ParagraphData: Represents a text paragraph with formatting
    ShapeData: Represents a shape with position and text content

Main Functions:
    extract_text_inventory: Extract all text from a presentation
    save_inventory: Save extracted data to JSON

Usage:
    python inventory.py input.pptx output.json
"""

import argparse
import json
import platform
import re
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.shapes.base import BaseShape

# Type aliases for cleaner signatures
JsonValue = Union[str, int, float, bool, None]
ParagraphDict = Dict[str, JsonValue]
ShapeDict = Dict[
    str, Union[str, float, bool, List[ParagraphDict], List[str], Dict[str, Any], None]
]
InventoryData = Dict[
    str, Dict[str, "ShapeData"]
]  # Dict of slide_id -> {shape_id -> ShapeData}
InventoryDict = Dict[str, Dict[str, ShapeDict]]  # JSON-serializable inventory


def main():
    """Main entry point for command-line usage."""
    parser = argparse.ArgumentParser(
        description="Extract text inventory from PowerPoint with proper GroupShape support.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python inventory.py presentation.pptx inventory.json
    Extracts text inventory with correct absolute positions for grouped shapes

  python inventory.py presentation.pptx inventory.json --issues-only
    Extracts only text shapes that have overflow or overlap issues

The output JSON includes:
  - All text content organized by slide and shape
  - Correct absolute positions for shapes in groups
  - Visual position and size in inches
  - Paragraph properties and formatting
  - Issue detection: text overflow and shape overlaps
        """,
    )

    parser.add_argument("input", help="Input PowerPoint file (.pptx)")
    parser.add_argument("output", help="Output JSON file for inventory")
    parser.add_argument(
        "--issues-only",
        action="store_true",
        help="Include only text shapes that have overflow or overlap issues",
    )

    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: Input file not found: {args.input}")
        sys.exit(1)

    if not input_path.suffix.lower() == ".pptx":
        print("Error: Input must be a PowerPoint file (.pptx)")
        sys.exit(1)

    try:
        print(f"Extracting text inventory from: {args.input}")
        if args.issues_only:
            print(
                "Filtering to include only text shapes with issues (overflow/overlap)"
            )
        inventory = extract_text_inventory(input_path, issues_only=args.issues_only)

        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        save_inventory(inventory, output_path)

        print(f"Output saved to: {args.output}")

        # Report statistics
        total_slides = len(inventory)
        total_shapes = sum(len(shapes) for shapes in inventory.values())
        if args.issues_only:
            if total_shapes > 0:
                print(
                    f"Found {total_shapes} text elements with issues in {total_slides} slides"
                )
            else:
                print("No issues discovered")
        else:
            print(
                f"Found text in {total_slides} slides with {total_shapes} text elements"
            )

    except Exception as e:
        print(f"Error processing presentation: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)


SERIF_HINTS = (
    "baskerville",
    "cambria",
    "caslon",
    "garamond",
    "georgia",
    "lora",
    "playfair",
    "serif",
    "times",
)
_FONT_EXTENSIONS = {".ttf", ".otf", ".ttc", ".dfont"}


def _fallback_font_paths(
    *,
    serif: bool,
    bold: bool,
    italic: bool,
    font_name: str = "",
) -> list[str]:
    """Return style-aware fallbacks in roughly the order office renderers use.

    The production PPTX preview renderer substitutes Noto/Liberation when a
    requested Office font is unavailable.  Measuring with a regular fallback
    for bold text materially underestimates width, so every style combination
    gets an explicit candidate list.
    """

    style = "BoldItalic" if bold and italic else "Bold" if bold else "Italic" if italic else "Regular"
    spaced_style = "Bold Italic" if bold and italic else "Bold" if bold else "Italic" if italic else ""
    oblique_style = "BoldOblique" if bold and italic else "Bold" if bold else "Oblique" if italic else ""
    family_key = re.sub(r"[^a-z0-9]", "", font_name.lower())
    metric_compatible: list[str] = []
    if family_key in {"cambria", "caladea"}:
        metric_compatible.append(f"/usr/share/fonts/truetype/crosextra/Caladea-{style}.ttf")
    elif family_key in {"calibri", "carlito"}:
        metric_compatible.append(f"/usr/share/fonts/truetype/crosextra/Carlito-{style}.ttf")
    if serif:
        return metric_compatible + [
            f"/System/Library/Fonts/Supplemental/Georgia{(' ' + spaced_style) if spaced_style else ''}.ttf",
            f"/System/Library/Fonts/Supplemental/Times New Roman{(' ' + spaced_style) if spaced_style else ''}.ttf",
            f"/usr/share/fonts/truetype/noto/NotoSerif-{style}.ttf",
            f"/usr/share/fonts/truetype/liberation2/LiberationSerif-{style}.ttf",
            f"/usr/share/fonts/truetype/liberation/LiberationSerif-{style}.ttf",
            f"/usr/share/fonts/truetype/dejavu/DejaVuSerif-{style}.ttf" if style != "Regular" else "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
        ]
    return metric_compatible + [
        f"/System/Library/Fonts/Supplemental/Arial{(' ' + spaced_style) if spaced_style else ''}.ttf",
        f"/System/Library/Fonts/Helvetica{(' ' + spaced_style) if spaced_style else ''}.ttc",
        f"/usr/share/fonts/truetype/noto/NotoSans-{style}.ttf",
        f"/usr/share/fonts/truetype/liberation2/LiberationSans-{style}.ttf",
        f"/usr/share/fonts/truetype/liberation/LiberationSans-{style}.ttf",
        f"/usr/share/fonts/truetype/dejavu/DejaVuSans-{oblique_style}.ttf" if oblique_style else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]


def load_measure_font(font_name: str, size: int, *, bold: bool = False, italic: bool = False):
    """Load a font for text measurement at the CORRECT SIZE.

    Critical: PIL's bare load_default() is an ~11px bitmap font that ignores
    the requested size, which silently disables overflow detection for any
    font not installed on this machine. Always fall back to a sized system
    font instead (serif-aware so metrics stay roughly comparable)."""
    path = ShapeData.get_font_path(font_name, bold=bold, italic=italic) if font_name else None
    if path:
        try:
            return ImageFont.truetype(path, size=size)
        except Exception:
            pass
    serif = any(h in (font_name or "").lower() for h in SERIF_HINTS)
    primary = _fallback_font_paths(
        serif=serif,
        bold=bold,
        italic=italic,
        font_name=font_name,
    )
    secondary = _fallback_font_paths(
        serif=not serif,
        bold=bold,
        italic=italic,
        font_name=font_name,
    )
    candidates = primary + secondary
    for cand in candidates:
        if Path(cand).exists():
            try:
                return ImageFont.truetype(cand, size=size)
            except Exception:
                continue
    try:
        return ImageFont.load_default(size=size)  # Pillow >= 10.1
    except TypeError:
        return ImageFont.load_default()


@dataclass
class ShapeWithPosition:
    """A shape with its absolute position on the slide."""

    shape: BaseShape
    absolute_left: int  # in EMUs
    absolute_top: int  # in EMUs


class ParagraphData:
    """Data structure for paragraph properties extracted from a PowerPoint paragraph."""

    def __init__(self, paragraph: Any):
        """Initialize from a PowerPoint paragraph object.

        Args:
            paragraph: The PowerPoint paragraph object
        """
        self.text: str = paragraph.text.strip()
        self.bullet: bool = False
        self.level: Optional[int] = None
        self.alignment: Optional[str] = None
        self.space_before: Optional[float] = None
        self.space_after: Optional[float] = None
        self.font_name: Optional[str] = None
        self.font_size: Optional[float] = None
        self.bold: Optional[bool] = None
        self.italic: Optional[bool] = None
        self.underline: Optional[bool] = None
        self.color: Optional[str] = None
        self.theme_color: Optional[str] = None
        self.line_spacing: Optional[float] = None

        # Check for bullet formatting
        if (
            hasattr(paragraph, "_p")
            and paragraph._p is not None
            and paragraph._p.pPr is not None
        ):
            pPr = paragraph._p.pPr
            ns = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
            if (
                pPr.find(f"{ns}buChar") is not None
                or pPr.find(f"{ns}buAutoNum") is not None
            ):
                self.bullet = True
                if hasattr(paragraph, "level"):
                    self.level = paragraph.level

        # Add alignment if not LEFT (default)
        if hasattr(paragraph, "alignment") and paragraph.alignment is not None:
            alignment_map = {
                PP_ALIGN.CENTER: "CENTER",
                PP_ALIGN.RIGHT: "RIGHT",
                PP_ALIGN.JUSTIFY: "JUSTIFY",
            }
            if paragraph.alignment in alignment_map:
                self.alignment = alignment_map[paragraph.alignment]

        # Add spacing properties if set
        if hasattr(paragraph, "space_before") and paragraph.space_before:
            self.space_before = paragraph.space_before.pt
        if hasattr(paragraph, "space_after") and paragraph.space_after:
            self.space_after = paragraph.space_after.pt

        # Extract font properties from first run
        if paragraph.runs:
            first_run = paragraph.runs[0]
            if hasattr(first_run, "font"):
                font = first_run.font
                if font.name:
                    self.font_name = font.name
                if font.size:
                    self.font_size = font.size.pt
                if font.bold is not None:
                    self.bold = font.bold
                if font.italic is not None:
                    self.italic = font.italic
                if font.underline is not None:
                    self.underline = font.underline

                # Handle color - both RGB and theme colors
                try:
                    # Try RGB color first
                    if font.color.rgb:
                        self.color = str(font.color.rgb)
                except (AttributeError, TypeError):
                    # Fall back to theme color
                    try:
                        if font.color.theme_color:
                            self.theme_color = font.color.theme_color.name
                    except (AttributeError, TypeError):
                        pass

        # Add line spacing if set
        if hasattr(paragraph, "line_spacing") and paragraph.line_spacing is not None:
            if hasattr(paragraph.line_spacing, "pt"):
                self.line_spacing = round(paragraph.line_spacing.pt, 2)
            else:
                # Multiplier - convert to points
                font_size = self.font_size if self.font_size else 12.0
                self.line_spacing = round(paragraph.line_spacing * font_size, 2)

    def to_dict(self) -> ParagraphDict:
        """Convert to dictionary for JSON serialization, excluding None values."""
        result: ParagraphDict = {"text": self.text}

        # Add optional fields only if they have values
        if self.bullet:
            result["bullet"] = self.bullet
        if self.level is not None:
            result["level"] = self.level
        if self.alignment:
            result["alignment"] = self.alignment
        if self.space_before is not None:
            result["space_before"] = self.space_before
        if self.space_after is not None:
            result["space_after"] = self.space_after
        if self.font_name:
            result["font_name"] = self.font_name
        if self.font_size is not None:
            result["font_size"] = self.font_size
        if self.bold is not None:
            result["bold"] = self.bold
        if self.italic is not None:
            result["italic"] = self.italic
        if self.underline is not None:
            result["underline"] = self.underline
        if self.color:
            result["color"] = self.color
        if self.theme_color:
            result["theme_color"] = self.theme_color
        if self.line_spacing is not None:
            result["line_spacing"] = self.line_spacing

        return result


class ShapeData:
    """Data structure for shape properties extracted from a PowerPoint shape."""

    @staticmethod
    def emu_to_inches(emu: int) -> float:
        """Convert EMUs (English Metric Units) to inches."""
        return emu / 914400.0

    @staticmethod
    def inches_to_pixels(inches: float, dpi: int = 96) -> int:
        """Convert inches to pixels at given DPI."""
        return int(inches * dpi)

    @staticmethod
    @lru_cache(maxsize=128)
    def get_font_path(font_name: str, *, bold: bool = False, italic: bool = False) -> Optional[str]:
        """Get the font file path for a given font name.

        Args:
            font_name: Name of the font (e.g., 'Arial', 'Calibri')

        Returns:
            Path to the font file, or None if not found
        """
        system = platform.system()

        # Define font directories and extensions by platform
        if system == "Darwin":  # macOS
            font_dirs = [
                "/System/Library/Fonts/",
                "/Library/Fonts/",
                "~/Library/Fonts/",
            ]
        else:  # Linux
            font_dirs = [
                "/usr/share/fonts/truetype/",
                "/usr/local/share/fonts/",
                "~/.fonts/",
            ]

        family_key = re.sub(r"[^a-z0-9]", "", font_name.lower())
        if not family_key:
            return None
        style_tokens = {"bold", "semibold", "demibold", "black", "heavy"}
        italic_tokens = {"italic", "oblique"}
        best: tuple[int, str] | None = None

        # Search recursively: macOS keeps common Office fonts under
        # ``Supplemental/`` and Linux font packages use family subdirectories.
        # The old top-level-only scan could pick ``SFGeorgian.ttf`` for
        # ``Georgia`` and stopped before the real face was considered.
        for font_dir in font_dirs:
            font_dir_path = Path(font_dir).expanduser()
            if not font_dir_path.exists():
                continue
            try:
                candidates = font_dir_path.rglob("*")
                for file_path in candidates:
                    if not file_path.is_file() or file_path.suffix.lower() not in _FONT_EXTENSIONS:
                        continue
                    stem_key = re.sub(r"[^a-z0-9]", "", file_path.stem.lower())
                    if not stem_key.startswith(family_key):
                        continue
                    suffix = stem_key[len(family_key) :]
                    has_bold = any(token in suffix for token in style_tokens)
                    has_italic = any(token in suffix for token in italic_tokens)
                    family_exact = suffix == "" or all(
                        token in style_tokens | italic_tokens | {"regular", "roman"}
                        for token in re.findall(r"[a-z]+", suffix)
                    )
                    score = 100 if family_exact else 60
                    score += 20 if has_bold == bold else -30
                    score += 15 if has_italic == italic else -25
                    candidate = (score, str(file_path))
                    if best is None or candidate > best:
                        best = candidate
            except (OSError, PermissionError):
                continue

        # Reject loose substring matches with a style mismatch. Falling back
        # to the correct serif/sans weight is safer than measuring the wrong
        # family or a regular face for bold text.
        if best is not None and best[0] >= 90:
            return best[1]

        return None

    @staticmethod
    def get_slide_dimensions(slide: Any) -> tuple[Optional[int], Optional[int]]:
        """Get slide dimensions from slide object.

        Args:
            slide: Slide object

        Returns:
            Tuple of (width_emu, height_emu) or (None, None) if not found
        """
        try:
            prs = slide.part.package.presentation_part.presentation
            return prs.slide_width, prs.slide_height
        except (AttributeError, TypeError):
            return None, None

    @staticmethod
    def get_default_font_size(shape: BaseShape, slide_layout: Any) -> Optional[float]:
        """Extract default font size from slide layout for a placeholder shape.

        Args:
            shape: Placeholder shape
            slide_layout: Slide layout containing the placeholder definition

        Returns:
            Default font size in points, or None if not found
        """
        try:
            if not hasattr(shape, "placeholder_format"):
                return None

            shape_type = shape.placeholder_format.type  # type: ignore
            for layout_placeholder in slide_layout.placeholders:
                if layout_placeholder.placeholder_format.type == shape_type:
                    # Find first defRPr element with sz (size) attribute
                    for elem in layout_placeholder.element.iter():
                        if "defRPr" in elem.tag and (sz := elem.get("sz")):
                            return float(sz) / 100.0  # Convert EMUs to points
                    break
        except Exception:
            pass
        return None

    def __init__(
        self,
        shape: BaseShape,
        absolute_left: Optional[int] = None,
        absolute_top: Optional[int] = None,
        slide: Optional[Any] = None,
    ):
        """Initialize from a PowerPoint shape object.

        Args:
            shape: The PowerPoint shape object (should be pre-validated)
            absolute_left: Absolute left position in EMUs (for shapes in groups)
            absolute_top: Absolute top position in EMUs (for shapes in groups)
            slide: Optional slide object to get dimensions and layout information
        """
        self.shape = shape  # Store reference to original shape
        self.shape_id: str = ""  # Will be set after sorting

        # Get slide dimensions from slide object
        self.slide_width_emu, self.slide_height_emu = (
            self.get_slide_dimensions(slide) if slide else (None, None)
        )

        # Get placeholder type if applicable
        self.placeholder_type: Optional[str] = None
        self.default_font_size: Optional[float] = None
        if hasattr(shape, "is_placeholder") and shape.is_placeholder:  # type: ignore
            if shape.placeholder_format and shape.placeholder_format.type:  # type: ignore
                self.placeholder_type = (
                    str(shape.placeholder_format.type).split(".")[-1].split(" ")[0]  # type: ignore
                )

                # Get default font size from layout
                if slide and hasattr(slide, "slide_layout"):
                    self.default_font_size = self.get_default_font_size(
                        shape, slide.slide_layout
                    )

        # Get position information
        # Use absolute positions if provided (for shapes in groups), otherwise use shape's position
        left_emu = (
            absolute_left
            if absolute_left is not None
            else (shape.left if hasattr(shape, "left") else 0)
        )
        top_emu = (
            absolute_top
            if absolute_top is not None
            else (shape.top if hasattr(shape, "top") else 0)
        )

        self.left: float = round(self.emu_to_inches(left_emu), 2)  # type: ignore
        self.top: float = round(self.emu_to_inches(top_emu), 2)  # type: ignore
        self.width: float = round(
            self.emu_to_inches(shape.width if hasattr(shape, "width") else 0),
            2,  # type: ignore
        )
        self.height: float = round(
            self.emu_to_inches(shape.height if hasattr(shape, "height") else 0),
            2,  # type: ignore
        )

        # Store EMU positions for overflow calculations
        self.left_emu = left_emu
        self.top_emu = top_emu
        self.width_emu = shape.width if hasattr(shape, "width") else 0
        self.height_emu = shape.height if hasattr(shape, "height") else 0

        # Calculate overflow status
        self.frame_overflow_bottom: Optional[float] = None
        self.slide_overflow_right: Optional[float] = None
        self.slide_overflow_bottom: Optional[float] = None
        self.overlapping_shapes: Dict[
            str, float
        ] = {}  # Dict of shape_id -> overlap area in sq inches
        self.warnings: List[str] = []
        self._estimate_frame_overflow()
        self._calculate_slide_overflow()
        self._detect_bullet_issues()

    @property
    def vertical_anchor(self) -> Optional[str]:
        """Vertical anchor of the text frame (TOP|MIDDLE|BOTTOM).

        Returns None when the anchor is the default top (or unreadable) so the
        inspect output stays uncluttered — mirrors how alignment is only shown
        when it is not the LEFT default."""
        if not self.shape or not getattr(self.shape, "has_text_frame", False):
            return None
        try:
            va = self.shape.text_frame.vertical_anchor
        except Exception:
            return None
        return {MSO_ANCHOR.MIDDLE: "MIDDLE", MSO_ANCHOR.BOTTOM: "BOTTOM"}.get(va)

    @property
    def paragraphs(self) -> List[ParagraphData]:
        """Calculate paragraphs from the shape's text frame."""
        if not self.shape or not hasattr(self.shape, "text_frame"):
            return []

        paragraphs = []
        for paragraph in self.shape.text_frame.paragraphs:  # type: ignore
            if paragraph.text.strip():
                paragraphs.append(ParagraphData(paragraph))
        return paragraphs

    def _get_default_font_size(self) -> int:
        """Get default font size from theme text styles or use conservative default."""
        try:
            if not (
                hasattr(self.shape, "part") and hasattr(self.shape.part, "slide_layout")
            ):
                return 14

            slide_master = self.shape.part.slide_layout.slide_master  # type: ignore
            if not hasattr(slide_master, "element"):
                return 14

            # Determine theme style based on placeholder type
            style_name = "bodyStyle"  # Default
            if self.placeholder_type and "TITLE" in self.placeholder_type:
                style_name = "titleStyle"

            # Find font size in theme styles
            for child in slide_master.element.iter():
                tag = child.tag.split("}")[-1] if "}" in child.tag else child.tag
                if tag == style_name:
                    for elem in child.iter():
                        if "sz" in elem.attrib:
                            return int(elem.attrib["sz"]) // 100
        except Exception:
            pass

        return 14  # Conservative default for body text

    def _get_usable_dimensions(self, text_frame) -> Tuple[int, int]:
        """Get usable width and height in pixels after accounting for margins."""
        # Default PowerPoint margins in inches
        margins = {"top": 0.05, "bottom": 0.05, "left": 0.1, "right": 0.1}

        # Override with actual margins if set (0 is a real value — explicit
        # zero insets must not fall back to the defaults)
        if getattr(text_frame, "margin_top", None) is not None:
            margins["top"] = self.emu_to_inches(text_frame.margin_top)
        if getattr(text_frame, "margin_bottom", None) is not None:
            margins["bottom"] = self.emu_to_inches(text_frame.margin_bottom)
        if getattr(text_frame, "margin_left", None) is not None:
            margins["left"] = self.emu_to_inches(text_frame.margin_left)
        if getattr(text_frame, "margin_right", None) is not None:
            margins["right"] = self.emu_to_inches(text_frame.margin_right)

        # Calculate usable area
        usable_width = self.width - margins["left"] - margins["right"]
        usable_height = self.height - margins["top"] - margins["bottom"]

        # Convert to pixels
        return (
            self.inches_to_pixels(usable_width),
            self.inches_to_pixels(usable_height),
        )

    def _wrap_text_line(self, line: str, max_width_px: int, draw, font) -> List[str]:
        """Wrap a single line of text to fit within max_width_px."""
        if not line:
            return [""]

        # Use textlength for efficient width calculation
        if draw.textlength(line, font=font) <= max_width_px:
            return [line]

        # Need to wrap - split into words
        wrapped = []
        words = line.split(" ")
        current_line = ""

        for word in words:
            test_line = current_line + (" " if current_line else "") + word
            if draw.textlength(test_line, font=font) <= max_width_px:
                current_line = test_line
            else:
                if current_line:
                    wrapped.append(current_line)
                current_line = word

        if current_line:
            wrapped.append(current_line)

        return wrapped

    def _paragraph_line_font_sizes(
        self,
        paragraph: Any,
        para_data: ParagraphData,
        *,
        max_width_px: int,
        draw: Any,
        default_font_size: float,
        font_scale: float,
    ) -> list[float]:
        """Wrap a paragraph using each run's actual font metrics.

        ``html2patch`` preserves mixed inline runs, so measuring the entire
        paragraph with the first run can miss a later bold or larger span.
        This lightweight token wrapper keeps run-specific widths and records
        the largest point size on every resulting line.
        """

        fallback_name = para_data.font_name or "Arial"
        fallback_size = float(para_data.font_size or default_font_size)
        styled_runs: list[tuple[str, str, float, bool, bool]] = []
        for run in paragraph.runs:
            text = str(run.text or "")
            if not text:
                continue
            font = run.font
            size_pt = float(font.size.pt) if font.size is not None else fallback_size
            styled_runs.append(
                (
                    text,
                    str(font.name or fallback_name),
                    max(1.0, size_pt * max(0.01, font_scale)),
                    bool(font.bold if font.bold is not None else para_data.bold),
                    bool(font.italic if font.italic is not None else para_data.italic),
                )
            )
        if not styled_runs:
            styled_runs.append(
                (
                    str(paragraph.text or ""),
                    fallback_name,
                    max(1.0, fallback_size * max(0.01, font_scale)),
                    bool(para_data.bold),
                    bool(para_data.italic),
                )
            )

        font_cache: dict[tuple[str, int, bool, bool], Any] = {}
        line_sizes: list[float] = []
        line_width = 0.0
        line_size = 0.0
        line_has_text = False
        pending_space_width = 0.0
        pending_space_size = 0.0

        def measured_width(text: str, name: str, size_pt: float, bold: bool, italic: bool) -> float:
            size_px = max(1, round(size_pt * 96 / 72))
            key = (name, size_px, bold, italic)
            font = font_cache.get(key)
            if font is None:
                font = load_measure_font(name, size_px, bold=bold, italic=italic)
                font_cache[key] = font
            return float(draw.textlength(text, font=font))

        def finish_line(*, force: bool = False, fallback_line_size: float = fallback_size) -> None:
            nonlocal line_width, line_size, line_has_text, pending_space_width, pending_space_size
            if line_has_text or force:
                line_sizes.append(max(line_size, fallback_line_size * max(0.01, font_scale), 1.0))
            line_width = 0.0
            line_size = 0.0
            line_has_text = False
            pending_space_width = 0.0
            pending_space_size = 0.0

        for text, name, size_pt, bold, italic in styled_runs:
            for token in re.findall(r"\n|[^\S\n]+|[^\s]+", text):
                if token == "\n":
                    finish_line(force=True, fallback_line_size=size_pt)
                    continue
                token_width = measured_width(token, name, size_pt, bold, italic)
                if token.isspace():
                    if line_has_text:
                        pending_space_width += token_width
                        pending_space_size = max(pending_space_size, size_pt)
                    continue
                candidate_width = line_width + pending_space_width + token_width
                if line_has_text and candidate_width > max_width_px:
                    finish_line()
                else:
                    line_width += pending_space_width
                    line_size = max(line_size, pending_space_size)
                line_width += token_width
                line_size = max(line_size, size_pt)
                line_has_text = True
                pending_space_width = 0.0
                pending_space_size = 0.0

        finish_line()
        return line_sizes

    def _frame_overflow_inches(self, *, font_scale: float = 1.0) -> Optional[float]:
        """Estimate frame overflow at ``font_scale`` using 96-DPI text metrics.

        PowerPoint run sizes are points while Pillow expects pixel sizes.  The
        previous implementation passed the point value straight to Pillow,
        making every measured glyph about 25% too narrow at 96 DPI.  That was
        enough for a one-line HTML title to rewrap under LibreOffice without
        the native lint seeing it.
        """
        if not self.shape or not hasattr(self.shape, "text_frame"):
            return None

        text_frame = self.shape.text_frame  # type: ignore
        if not text_frame or not text_frame.paragraphs:
            return None

        # Get usable dimensions after accounting for margins
        usable_width_px, usable_height_px = self._get_usable_dimensions(text_frame)
        if usable_width_px <= 0 or usable_height_px <= 0:
            return None

        # Set up PIL for text measurement
        dummy_img = Image.new("RGB", (1, 1))
        draw = ImageDraw.Draw(dummy_img)

        # Get default font size from placeholder or use conservative estimate
        default_font_size = self._get_default_font_size()

        # Calculate total height of all paragraphs
        total_height_px = 0

        for para_idx, paragraph in enumerate(text_frame.paragraphs):
            if not paragraph.text.strip():
                continue

            para_data = ParagraphData(paragraph)

            line_font_sizes = self._paragraph_line_font_sizes(
                paragraph,
                para_data,
                max_width_px=usable_width_px,
                draw=draw,
                default_font_size=default_font_size,
                font_scale=font_scale,
            )

            if line_font_sizes:
                # Calculate line height
                if para_data.line_spacing:
                    # A fixed line spacing smaller than a later inline run does
                    # not make that glyph shorter; keep the larger contribution.
                    paragraph_height_px = sum(
                        max(para_data.line_spacing, size_pt) * 96 / 72
                        for size_pt in line_font_sizes
                    )
                else:
                    # PowerPoint default single spacing follows the tallest
                    # run on each line, not merely the paragraph's first run.
                    paragraph_height_px = sum(size_pt * 96 / 72 for size_pt in line_font_sizes)

                # Add space_before (except first paragraph)
                if para_idx > 0 and para_data.space_before:
                    total_height_px += para_data.space_before * 96 / 72

                # Add paragraph text height
                total_height_px += paragraph_height_px

                # Add space_after
                if para_data.space_after:
                    total_height_px += para_data.space_after * 96 / 72

        # Check for overflow (ignore negligible overflows <= 0.05")
        if total_height_px > usable_height_px:
            overflow_px = total_height_px - usable_height_px
            overflow_inches = round(overflow_px / 96.0, 2)
            if overflow_inches > 0.05:  # Only report significant overflows
                return overflow_inches
        return None

    def _estimate_frame_overflow(self) -> None:
        """Estimate if text overflows the shape bounds using PIL text measurement."""
        self.frame_overflow_bottom = self._frame_overflow_inches()

    def font_scale_to_fit(self, minimum_scale: float = 0.6) -> float:
        """Largest uniform font scale whose estimated text fits this frame.

        The deterministic fixer uses this instead of deriving a scale from
        overflow *height*.  A single extra wrapped line previously forced the
        global 0.6 floor even when a small width adjustment (for example 0.86)
        was sufficient to keep a headline on one line.
        """

        floor = min(1.0, max(0.05, float(minimum_scale)))
        if self._frame_overflow_inches(font_scale=1.0) is None:
            return 1.0
        if self._frame_overflow_inches(font_scale=floor) is not None:
            return floor
        low, high = floor, 1.0
        for _ in range(14):
            midpoint = (low + high) / 2
            if self._frame_overflow_inches(font_scale=midpoint) is None:
                low = midpoint
            else:
                high = midpoint
        return round(low, 4)

    def _calculate_slide_overflow(self) -> None:
        """Calculate if shape overflows the slide boundaries."""
        if self.slide_width_emu is None or self.slide_height_emu is None:
            return

        # Check right overflow (ignore negligible overflows <= 0.01")
        right_edge_emu = self.left_emu + self.width_emu
        if right_edge_emu > self.slide_width_emu:
            overflow_emu = right_edge_emu - self.slide_width_emu
            overflow_inches = round(self.emu_to_inches(overflow_emu), 2)
            if overflow_inches > 0.01:  # Only report significant overflows
                self.slide_overflow_right = overflow_inches

        # Check bottom overflow (ignore negligible overflows <= 0.01")
        bottom_edge_emu = self.top_emu + self.height_emu
        if bottom_edge_emu > self.slide_height_emu:
            overflow_emu = bottom_edge_emu - self.slide_height_emu
            overflow_inches = round(self.emu_to_inches(overflow_emu), 2)
            if overflow_inches > 0.01:  # Only report significant overflows
                self.slide_overflow_bottom = overflow_inches

    def _detect_bullet_issues(self) -> None:
        """Detect bullet point formatting issues in paragraphs."""
        if not self.shape or not hasattr(self.shape, "text_frame"):
            return

        text_frame = self.shape.text_frame  # type: ignore
        if not text_frame or not text_frame.paragraphs:
            return

        # Common bullet symbols that indicate manual bullets
        bullet_symbols = ["•", "●", "○"]

        for paragraph in text_frame.paragraphs:
            text = paragraph.text.strip()
            # Check for manual bullet symbols
            if text and any(text.startswith(symbol + " ") for symbol in bullet_symbols):
                self.warnings.append(
                    "manual_bullet_symbol: use proper bullet formatting"
                )
                break

    @property
    def has_any_issues(self) -> bool:
        """Check if shape has any issues (overflow, overlap, or warnings)."""
        return (
            self.frame_overflow_bottom is not None
            or self.slide_overflow_right is not None
            or self.slide_overflow_bottom is not None
            or len(self.overlapping_shapes) > 0
            or len(self.warnings) > 0
        )

    def to_dict(self) -> ShapeDict:
        """Convert to dictionary for JSON serialization."""
        result: ShapeDict = {
            "left": self.left,
            "top": self.top,
            "width": self.width,
            "height": self.height,
        }

        # Add optional fields if present
        if self.placeholder_type:
            result["placeholder_type"] = self.placeholder_type

        if self.default_font_size:
            result["default_font_size"] = self.default_font_size

        # Add overflow information only if there is overflow
        overflow_data = {}

        # Add frame overflow if present
        if self.frame_overflow_bottom is not None:
            overflow_data["frame"] = {"overflow_bottom": self.frame_overflow_bottom}

        # Add slide overflow if present
        slide_overflow = {}
        if self.slide_overflow_right is not None:
            slide_overflow["overflow_right"] = self.slide_overflow_right
        if self.slide_overflow_bottom is not None:
            slide_overflow["overflow_bottom"] = self.slide_overflow_bottom
        if slide_overflow:
            overflow_data["slide"] = slide_overflow

        # Only add overflow field if there is overflow
        if overflow_data:
            result["overflow"] = overflow_data

        # Add overlap field if there are overlapping shapes
        if self.overlapping_shapes:
            result["overlap"] = {"overlapping_shapes": self.overlapping_shapes}

        # Add warnings field if there are warnings
        if self.warnings:
            result["warnings"] = self.warnings

        # Vertical anchor — only when it differs from the default top
        anchor = self.vertical_anchor
        if anchor:
            result["anchor"] = anchor

        # Add paragraphs after placeholder_type
        result["paragraphs"] = [para.to_dict() for para in self.paragraphs]

        return result


def is_valid_shape(shape: BaseShape) -> bool:
    """Check if a shape contains meaningful text content."""
    # Must have a text frame with content
    if not hasattr(shape, "text_frame") or not shape.text_frame:  # type: ignore
        return False

    text = shape.text_frame.text.strip()  # type: ignore
    if not text:
        return False

    # Skip slide numbers and numeric footers
    if hasattr(shape, "is_placeholder") and shape.is_placeholder:  # type: ignore
        if shape.placeholder_format and shape.placeholder_format.type:  # type: ignore
            placeholder_type = (
                str(shape.placeholder_format.type).split(".")[-1].split(" ")[0]  # type: ignore
            )
            if placeholder_type == "SLIDE_NUMBER":
                return False
            if placeholder_type == "FOOTER" and text.isdigit():
                return False

    return True


def collect_shapes_with_absolute_positions(
    shape: BaseShape, parent_left: int = 0, parent_top: int = 0
) -> List[ShapeWithPosition]:
    """Recursively collect all shapes with valid text, calculating absolute positions.

    For shapes within groups, their positions are relative to the group.
    This function calculates the absolute position on the slide by accumulating
    parent group offsets.

    Args:
        shape: The shape to process
        parent_left: Accumulated left offset from parent groups (in EMUs)
        parent_top: Accumulated top offset from parent groups (in EMUs)

    Returns:
        List of ShapeWithPosition objects with absolute positions
    """
    if hasattr(shape, "shapes"):  # GroupShape
        result = []
        # Get this group's position
        group_left = shape.left if hasattr(shape, "left") else 0
        group_top = shape.top if hasattr(shape, "top") else 0

        # Calculate absolute position for this group
        abs_group_left = parent_left + group_left
        abs_group_top = parent_top + group_top

        # Process children with accumulated offsets
        for child in shape.shapes:  # type: ignore
            result.extend(
                collect_shapes_with_absolute_positions(
                    child, abs_group_left, abs_group_top
                )
            )
        return result

    # Regular shape - check if it has valid text
    if is_valid_shape(shape):
        # Calculate absolute position
        shape_left = shape.left if hasattr(shape, "left") else 0
        shape_top = shape.top if hasattr(shape, "top") else 0

        return [
            ShapeWithPosition(
                shape=shape,
                absolute_left=parent_left + shape_left,
                absolute_top=parent_top + shape_top,
            )
        ]

    return []


def sort_shapes_by_position(shapes: List[ShapeData]) -> List[ShapeData]:
    """Sort shapes by visual position (top-to-bottom, left-to-right).

    Shapes within 0.5 inches vertically are considered on the same row.
    """
    if not shapes:
        return shapes

    # Sort by top position first
    shapes = sorted(shapes, key=lambda s: (s.top, s.left))

    # Group shapes by row (within 0.5 inches vertically)
    result = []
    row = [shapes[0]]
    row_top = shapes[0].top

    for shape in shapes[1:]:
        if abs(shape.top - row_top) <= 0.5:
            row.append(shape)
        else:
            # Sort current row by left position and add to result
            result.extend(sorted(row, key=lambda s: s.left))
            row = [shape]
            row_top = shape.top

    # Don't forget the last row
    result.extend(sorted(row, key=lambda s: s.left))
    return result


def calculate_overlap(
    rect1: Tuple[float, float, float, float],
    rect2: Tuple[float, float, float, float],
    tolerance: float = 0.05,
) -> Tuple[bool, float]:
    """Calculate if and how much two rectangles overlap.

    Args:
        rect1: (left, top, width, height) of first rectangle in inches
        rect2: (left, top, width, height) of second rectangle in inches
        tolerance: Minimum overlap in inches to consider as overlapping (default: 0.05")

    Returns:
        Tuple of (overlaps, overlap_area) where:
        - overlaps: True if rectangles overlap by more than tolerance
        - overlap_area: Area of overlap in square inches
    """
    left1, top1, w1, h1 = rect1
    left2, top2, w2, h2 = rect2

    # Calculate overlap dimensions
    overlap_width = min(left1 + w1, left2 + w2) - max(left1, left2)
    overlap_height = min(top1 + h1, top2 + h2) - max(top1, top2)

    # Check if there's meaningful overlap (more than tolerance)
    if overlap_width > tolerance and overlap_height > tolerance:
        # Calculate overlap area in square inches
        overlap_area = overlap_width * overlap_height
        return True, round(overlap_area, 2)

    return False, 0


def detect_overlaps(shapes: List[ShapeData]) -> None:
    """Detect overlapping shapes and update their overlapping_shapes dictionaries.

    This function requires each ShapeData to have its shape_id already set.
    It modifies the shapes in-place, adding shape IDs with overlap areas in square inches.

    Args:
        shapes: List of ShapeData objects with shape_id attributes set
    """
    n = len(shapes)

    # Compare each pair of shapes
    for i in range(n):
        for j in range(i + 1, n):
            shape1 = shapes[i]
            shape2 = shapes[j]

            # Ensure shape IDs are set
            assert shape1.shape_id, f"Shape at index {i} has no shape_id"
            assert shape2.shape_id, f"Shape at index {j} has no shape_id"

            rect1 = (shape1.left, shape1.top, shape1.width, shape1.height)
            rect2 = (shape2.left, shape2.top, shape2.width, shape2.height)

            overlaps, overlap_area = calculate_overlap(rect1, rect2)

            if overlaps:
                # Add shape IDs with overlap area in square inches
                shape1.overlapping_shapes[shape2.shape_id] = overlap_area
                shape2.overlapping_shapes[shape1.shape_id] = overlap_area


def cluster_1d(items, eps):
    """Greedy 1-D clustering of edge coordinates.

    items: iterable of (key, coord) pairs (key identifies who owns the edge).
    Sorts by coord and starts a new cluster wherever the gap to the previous
    coord exceeds eps. Returns a list of clusters, each a list of (key, coord).
    Single-linkage drift is irrelevant here: real gridlines are far tighter
    than eps, so a populated cluster stays tight."""
    out = []
    cur = []
    last = None
    for key, coord in sorted(items, key=lambda kc: kc[1]):
        if last is not None and coord - last > eps:
            out.append(cur)
            cur = []
        cur.append((key, coord))
        last = coord
    if cur:
        out.append(cur)
    return out


def extract_text_inventory(
    pptx_path: Path, prs: Optional[Any] = None, issues_only: bool = False
) -> InventoryData:
    """Extract text content from all slides in a PowerPoint presentation.

    Args:
        pptx_path: Path to the PowerPoint file
        prs: Optional Presentation object to use. If not provided, will load from pptx_path.
        issues_only: If True, only include shapes that have overflow or overlap issues

    Returns a nested dictionary: {slide-N: {shape-N: ShapeData}}
    Shapes are sorted by visual position (top-to-bottom, left-to-right).
    The ShapeData objects contain the full shape information and can be
    converted to dictionaries for JSON serialization using to_dict().
    """
    if prs is None:
        prs = Presentation(str(pptx_path))
    inventory: InventoryData = {}

    for slide_idx, slide in enumerate(prs.slides):
        # Collect all valid shapes from this slide with absolute positions
        shapes_with_positions = []
        for shape in slide.shapes:  # type: ignore
            shapes_with_positions.extend(collect_shapes_with_absolute_positions(shape))

        if not shapes_with_positions:
            continue

        # Convert to ShapeData with absolute positions and slide reference
        shape_data_list = [
            ShapeData(
                swp.shape,
                swp.absolute_left,
                swp.absolute_top,
                slide,
            )
            for swp in shapes_with_positions
        ]

        # Sort by visual position and assign stable IDs in one step
        sorted_shapes = sort_shapes_by_position(shape_data_list)
        for idx, shape_data in enumerate(sorted_shapes):
            shape_data.shape_id = f"shape-{idx}"

        # Detect overlaps using the stable shape IDs
        if len(sorted_shapes) > 1:
            detect_overlaps(sorted_shapes)

        # Filter for issues only if requested (after overlap detection)
        if issues_only:
            sorted_shapes = [sd for sd in sorted_shapes if sd.has_any_issues]

        if not sorted_shapes:
            continue

        # Create slide inventory using the stable shape IDs
        inventory[f"slide-{slide_idx}"] = {
            shape_data.shape_id: shape_data for shape_data in sorted_shapes
        }

    return inventory


def get_inventory_as_dict(pptx_path: Path, issues_only: bool = False) -> InventoryDict:
    """Extract text inventory and return as JSON-serializable dictionaries.

    This is a convenience wrapper around extract_text_inventory that returns
    dictionaries instead of ShapeData objects, useful for testing and direct
    JSON serialization.

    Args:
        pptx_path: Path to the PowerPoint file
        issues_only: If True, only include shapes that have overflow or overlap issues

    Returns:
        Nested dictionary with all data serialized for JSON
    """
    inventory = extract_text_inventory(pptx_path, issues_only=issues_only)

    # Convert ShapeData objects to dictionaries
    dict_inventory: InventoryDict = {}
    for slide_key, shapes in inventory.items():
        dict_inventory[slide_key] = {
            shape_key: shape_data.to_dict() for shape_key, shape_data in shapes.items()
        }

    return dict_inventory


def save_inventory(inventory: InventoryData, output_path: Path) -> None:
    """Save inventory to JSON file with proper formatting.

    Converts ShapeData objects to dictionaries for JSON serialization.
    """
    # Convert ShapeData objects to dictionaries
    json_inventory: InventoryDict = {}
    for slide_key, shapes in inventory.items():
        json_inventory[slide_key] = {
            shape_key: shape_data.to_dict() for shape_key, shape_data in shapes.items()
        }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(json_inventory, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
