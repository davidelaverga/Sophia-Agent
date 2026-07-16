from __future__ import annotations

from pathlib import Path

import pytest
from langchain_core.messages import HumanMessage
from langchain_openai import ChatOpenAI
from langchain_openai.chat_models.base import (
    _convert_chat_completions_blocks_to_responses,
)
from PIL import Image

from deerflow.sophia.deck_quality.contact_sheet import create_contact_sheet
from deerflow.sophia.deck_quality.messages import (
    DIRECT_EVIDENCE_MAX_ORIGINAL_SLIDE_PATCHES,
    DirectEvidenceBudgetError,
    _image_blocks,
    _validate_direct_evidence_budget,
)


def test_slide_images_use_original_detail_and_contact_sheet_stays_high(
    tmp_path: Path,
) -> None:
    contact_sheet = tmp_path / "contact-sheet.png"
    slide = tmp_path / "slide-1.png"
    contact_sheet.write_bytes(b"contact-sheet")
    slide.write_bytes(b"slide")

    blocks = _image_blocks(
        contact_sheet_path=contact_sheet.as_posix(),
        slides=(("slide:1", slide.as_posix()),),
    )
    images = [block for block in blocks if block["type"] == "image_url"]

    assert images[0]["image_url"]["detail"] == "high"
    assert images[1]["image_url"]["detail"] == "original"


def test_contact_sheet_is_client_bounded_before_high_detail_transport(
    tmp_path: Path,
) -> None:
    slides = tuple(tmp_path / f"slide-{index}.png" for index in range(1, 6))
    for path in slides:
        Image.new("RGB", (800, 450), "navy").save(path, format="PNG")

    output = create_contact_sheet(slides, tmp_path / "contact-sheet.png")

    with Image.open(output) as image:
        assert image.format == "PNG"
        assert max(image.size) == 2048


def test_original_slide_patch_budget_accepts_locked_geometry_and_rejects_more(
    tmp_path: Path,
) -> None:
    contact = tmp_path / "contact.png"
    contact.write_bytes(b"contact")
    slides = []
    for index in range(1, 6):
        path = tmp_path / f"slide-{index}.png"
        path.write_bytes(b"slide")
        slides.append((f"slide:{index}", path.as_posix(), 2200, 1238))

    usage = _validate_direct_evidence_budget(
        expected_slide_count=5,
        selectors=tuple(f"slide:{index}" for index in range(1, 6)),
        slides=tuple(slides),
        contact_sheet=(contact.as_posix(), 2048, 792),
        text_payload={"bounded": True},
    )

    assert DIRECT_EVIDENCE_MAX_ORIGINAL_SLIDE_PATCHES == 13_500
    assert usage.slide_count == 5

    over_budget = tuple(
        (selector, path, width, 1279)
        for selector, path, width, _height in slides
    )
    with pytest.raises(DirectEvidenceBudgetError, match="original-patch"):
        _validate_direct_evidence_budget(
            expected_slide_count=5,
            selectors=tuple(f"slide:{index}" for index in range(1, 6)),
            slides=over_budget,
            contact_sheet=(contact.as_posix(), 2048, 792),
            text_payload={"bounded": True},
        )


def test_pinned_responses_transport_preserves_original_detail() -> None:
    converted = _convert_chat_completions_blocks_to_responses(
        {
            "type": "image_url",
            "image_url": {
                "url": "data:image/png;base64,c2xpZGU=",
                "detail": "original",
            },
        }
    )

    assert converted == {
        "type": "input_image",
        "image_url": "data:image/png;base64,c2xpZGU=",
        "detail": "original",
    }


def test_pinned_responses_transport_locks_reasoning_and_statelessness() -> None:
    model = ChatOpenAI(
        model="gpt-5.6-sol",
        api_key="sk-test",
        use_responses_api=True,
        reasoning={
            "effort": "high",
            "mode": "standard",
            "context": "current_turn",
        },
        store=False,
    )

    payload = model._get_request_payload([HumanMessage(content="synthetic")])

    assert payload["reasoning"] == {
        "effort": "high",
        "mode": "standard",
        "context": "current_turn",
    }
    assert payload["store"] is False
    assert payload.get("previous_response_id") is None
