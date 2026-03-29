"""Centralized path constants for the Sophia companion agent.

All path computations derive from PROJECT_ROOT so that agent.py,
user_identity.py, and session_state.py share a single source of truth.
"""

from pathlib import Path

# paths.py -> sophia_agent -> agents -> deerflow -> harness -> packages -> backend -> REPO_ROOT
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent.parent.parent
SKILLS_PATH = PROJECT_ROOT / "skills" / "public" / "sophia"
USERS_DIR = PROJECT_ROOT / "users"
