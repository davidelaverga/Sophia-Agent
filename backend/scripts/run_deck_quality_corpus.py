from __future__ import annotations

import argparse
import json
from pathlib import Path

from deerflow.sophia.deck_quality.fixture_runner import load_corpus, validate_campaign_corpus

DEFAULT_CORPUS = Path(__file__).resolve().parents[1] / "tests/fixtures/deck_quality_shadow/corpus.yaml"


def main() -> int:
    parser = argparse.ArgumentParser(description="Report DQ-1 fixture-corpus readiness")
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--require-ready", action="store_true")
    args = parser.parse_args()
    corpus = load_corpus(args.corpus)
    report = validate_campaign_corpus(corpus, root=args.corpus.parent)
    print(json.dumps(report.model_dump(mode="json"), indent=2, sort_keys=True))
    return 0 if report.ready or not args.require_ready else 2


if __name__ == "__main__":
    raise SystemExit(main())
