#!/usr/bin/env python3
"""Canonical effective FC-01 evaluator dispatcher.

FC-01 v1.2 remains immutable historical evidence.  This dispatcher never uses
the obsolete v1.2 joint-approval evaluator as current campaign authority.  It
delegates all draft, seal, activation, projection, approval-packet, and clock
classification to the additive v1.3 evaluator.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


PACKAGE = "fc01-v1.3-amendment-b-20260817t194401z"


def main() -> int:
    campaign = Path(__file__).resolve().parent
    evaluator = campaign / "evidence" / PACKAGE / "evaluator.py"
    if not evaluator.is_file() or evaluator.is_symlink():
        print("BLOCKED_EVIDENCE: effective FC-01 v1.3 evaluator missing", file=sys.stderr)
        print("repair_authorized=false", file=sys.stderr)
        print("deployment_authorized=false", file=sys.stderr)
        print("m00_authorized=false", file=sys.stderr)
        print("post_m00_live_client_authorized=false", file=sys.stderr)
        print("main_merge_authorized=false", file=sys.stderr)
        return 1
    os.execv(sys.executable, [sys.executable, str(evaluator), *sys.argv[1:]])
    return 1  # pragma: no cover - os.execv does not return


if __name__ == "__main__":
    raise SystemExit(main())
