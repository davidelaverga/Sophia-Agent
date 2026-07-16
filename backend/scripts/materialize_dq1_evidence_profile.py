from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from pathlib import Path
from typing import Any

from PIL import Image

from deerflow.sophia.deck_quality.canonical import file_sha256
from deerflow.sophia.deck_quality.contact_sheet import (
    CONTACT_SHEET_MAX_DIMENSION,
    create_contact_sheet,
)
from deerflow.sophia.deck_quality.messages import (
    DIRECT_EVIDENCE_BUDGET_VERSION,
    DIRECT_EVIDENCE_MAX_SLIDE_DIMENSION,
)
from deerflow.sophia.deck_quality.snapshot import rasterize_preview_pdf
from deerflow.sophia.pptx_preview import maybe_render_pptx_preview

_SOURCE_FILES = (
    "artifact.pptx",
    "brief.json",
    "creative_plan.json",
    "design_plan.json",
    "mechanical_report.json",
    "visible_text.json",
)


def _write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def materialize_profile(
    *,
    source_bundle: Path,
    output_dir: Path,
    fixture_id: str,
) -> None:
    """Re-render a historical source bundle through the locked v4 pipeline."""

    source_manifest = json.loads(
        (source_bundle / "manifest.json").read_text(encoding="utf-8")
    )
    if output_dir.exists():
        raise FileExistsError(f"refusing to overwrite evidence bundle: {output_dir}")
    output_dir.mkdir(parents=True)
    for name in _SOURCE_FILES:
        source = source_bundle / name
        if not source.is_file():
            raise FileNotFoundError(source)
        shutil.copyfile(source, output_dir / name)

    render_dir = output_dir / "renders"
    render_dir.mkdir()
    with tempfile.TemporaryDirectory(prefix="dq1-evidence-v4-") as directory:
        staged_pptx = Path(directory) / "artifact.pptx"
        shutil.copyfile(output_dir / "artifact.pptx", staged_pptx)
        preview = maybe_render_pptx_preview(staged_pptx)
        if preview is None:
            raise RuntimeError("the locked PPTX preview renderer did not produce a PDF")
        pages = rasterize_preview_pdf(preview)
    slide_paths: list[Path] = []
    for index, page in enumerate(pages, start=1):
        path = render_dir / f"slide-{index}.png"
        path.write_bytes(page)
        slide_paths.append(path)
    create_contact_sheet(tuple(slide_paths), render_dir / "contact-sheet.png")

    render_dimensions: dict[str, list[int]] = {}
    for path in sorted(render_dir.glob("*.png")):
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            width, height = image.size
        maximum = (
            CONTACT_SHEET_MAX_DIMENSION
            if path.name == "contact-sheet.png"
            else DIRECT_EVIDENCE_MAX_SLIDE_DIMENSION
        )
        if max(width, height) > maximum:
            raise RuntimeError(f"render dimension exceeds the v4 lock: {path.name}")
        render_dimensions[path.name] = [width, height]

    copied_source_hashes = dict(source_manifest["source_hashes"])
    if file_sha256(output_dir / "artifact.pptx") != copied_source_hashes["artifact.pptx"]:
        raise RuntimeError("source PPTX bytes changed during evidence materialization")
    manifest = {
        **source_manifest,
        "fixture_id": fixture_id,
        "source_fixture_id": source_manifest["fixture_id"],
        "evidence_preprocessor_version": "deck-evidence-v4",
        "direct_evidence_budget_version": DIRECT_EVIDENCE_BUDGET_VERSION,
        "raster_max_dimension": DIRECT_EVIDENCE_MAX_SLIDE_DIMENSION,
        "contact_sheet_max_dimension": CONTACT_SHEET_MAX_DIMENSION,
        "render_dimensions": render_dimensions,
        "render_hashes": {
            path.name: file_sha256(path)
            for path in sorted(render_dir.glob("*.png"))
        },
    }
    _write_json(output_dir / "manifest.json", manifest)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Materialize a versioned DQ-1 rendered-evidence profile"
    )
    parser.add_argument("--source-bundle", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--fixture-id", required=True)
    args = parser.parse_args()
    materialize_profile(
        source_bundle=args.source_bundle,
        output_dir=args.output_dir,
        fixture_id=args.fixture_id,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
