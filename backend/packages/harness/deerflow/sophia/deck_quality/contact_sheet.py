from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

CONTACT_SHEET_MAX_DIMENSION = 2048


def create_contact_sheet(
    slide_paths: tuple[Path, ...],
    output_path: Path,
    *,
    columns: int = 3,
    label_height: int = 36,
    gap: int = 20,
    max_dimension: int = CONTACT_SHEET_MAX_DIMENSION,
) -> Path:
    """Create a bounded lossless-PNG, selector-labelled sequence view.

    Individual slides retain the locked original-judgment resolution. The
    contact sheet is a sequence/rhythm aid sent with ``detail=high``; bounding
    its grid prevents an unpriced second copy of every native slide.
    """

    if not slide_paths:
        raise ValueError("contact sheet requires at least one slide")
    if columns < 1:
        raise ValueError("contact sheet columns must be positive")
    if max_dimension < 512:
        raise ValueError("contact sheet maximum dimension is too small")
    opened = [Image.open(path).convert("RGB") for path in slide_paths]
    try:
        width = max(image.width for image in opened)
        height = max(image.height for image in opened)
        rows = math.ceil(len(opened) / columns)
        sheet = Image.new(
            "RGB",
            (columns * width + (columns - 1) * gap, rows * (height + label_height) + (rows - 1) * gap),
            "white",
        )
        draw = ImageDraw.Draw(sheet)
        for index, image in enumerate(opened):
            row, column = divmod(index, columns)
            x = column * (width + gap)
            y = row * (height + label_height + gap)
            sheet.paste(image, (x, y + label_height))
            draw.text((x + 8, y + 8), f"slide:{index + 1}", fill="black")
        if max(sheet.size) > max_dimension:
            sheet.thumbnail(
                (max_dimension, max_dimension),
                resample=Image.Resampling.LANCZOS,
            )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(output_path, format="PNG", optimize=False)
        return output_path
    finally:
        for image in opened:
            image.close()
