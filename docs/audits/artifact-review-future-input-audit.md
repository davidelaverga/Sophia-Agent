# Artifact Review Future Input Audit

Status: docs-only audit and plan. This slice does not implement OCR, broad VAD changes, arbiter changes, liveframes, dynamic fixtures, or provider model selection changes.

## Why OCR Is Separate From PDF Text Extraction

PDF text extraction reads embedded text from the PDF structure through PDF.js `textContent`. It is deterministic, local to the document parser, and does not require image recognition. OCR is a different system: it renders or reads pixels, guesses text from images, and usually needs additional models, preprocessing, language detection, layout reconstruction, and confidence scoring.

Keeping OCR separate avoids mixing two trust levels. Extracted PDF text can be marked as exact when PDF.js returns real text content. OCR text should be opt-in and labeled differently because it can misread scanned pages, charts, handwriting, small type, or rotated layouts.

## OCR Risks

- Accuracy: OCR can hallucinate or corrupt numbers, names, punctuation, tables, and page order.
- Cost: OCR may require rendering pages and invoking a vision or OCR model for each page.
- Privacy: OCR processes page images, which can expose more visual content than embedded text extraction.
- Latency: large scanned PDFs can block review flows unless queued or streamed carefully.
- Trust labeling: OCR output must never be presented as exact PDF text without confidence and provenance.

OCR is needed for scanned PDFs, image-only PDFs, screenshots, photographed pages, and standalone image artifacts where no embedded text exists.

## Why VAD And Arbiter Work Should Be Separate

Voice activity detection and arbiter behavior govern turn boundaries, interruption, user intent, and assistant response timing. Artifact review commands are local UI commands with a narrow lifecycle: parse, update page/zoom, mark the view stale, and refresh the still frame when possible.

Mixing a VAD or arbiter rewrite into artifact UI work would make failures harder to attribute. A broken page command could be caused by command parsing, state preservation, frame refresh, microphone transport, VAD turn closure, interruption handling, or arbiter routing. Those need separate evidence trails.

## Future Slices

1. OCR research/prototype: evaluate local and provider OCR options, confidence metadata, privacy constraints, and scanned-PDF detection.
2. OCR opt-in artifact text extraction: add explicit user-visible provenance and never mark OCR as exact PDF text.
3. VAD/arbiter audit: collect turn-boundary evidence for command utterances, interruptions, silence, and partial transcripts.
4. VAD/arbiter controlled rewrite: change one ownership boundary at a time with command, interruption, and normal conversation regression tests.
5. Liveframes/continuous visual review later: evaluate continuous visual context only after still-frame refresh and exact-text contracts are stable.
