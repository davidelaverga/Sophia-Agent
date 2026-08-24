#!/usr/bin/env python3
"""Compute the canonical, secret-safe Sophia Voice Lab plugin tree hash."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import re
import stat
import sys
from dataclasses import dataclass
from pathlib import Path


ALGORITHM = "sophia-plugin-tree-sha256-v1"
MAGIC = (ALGORITHM + "\0").encode("ascii")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

FORBIDDEN_BASENAMES = {
    ".env",
    ".netrc",
    "cookies.json",
    "credentials.json",
    "id_ed25519",
    "id_rsa",
    "secrets.json",
    "storage-state.json",
}
FORBIDDEN_SUFFIXES = {
    ".der",
    ".jks",
    ".key",
    ".keystore",
    ".p12",
    ".pfx",
    ".pem",
}
TRANSIENT_COMPONENTS = {".pytest_cache", "__pycache__"}
TRANSIENT_SUFFIXES = {".pyc", ".pyo", ".swp", ".tmp"}

SECRET_PATTERNS = (
    ("private key material", re.compile(rb"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")),
    ("OpenAI-style secret key", re.compile(rb"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}")),
    ("GitHub token", re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})")),
    ("AWS access key", re.compile(rb"\bAKIA[0-9A-Z]{16}\b")),
    (
        "literal credential field",
        re.compile(
            rb'(?i)"(?:access_token|refresh_token|client_secret|password|cookie|authorization)"'
            rb'\s*:\s*"(?!(?:<[^>]+>|\$\{[^}]+\}|REDACTED|CHANGEME)")[^"]{8,}"'
        ),
    ),
)


class PackageHashError(RuntimeError):
    """The package cannot be hashed without weakening the package contract."""


@dataclass(frozen=True)
class PackageHash:
    sha256: str
    file_count: int
    byte_count: int


def _relative_path(root: Path, candidate: Path) -> str:
    return candidate.relative_to(root).as_posix()


def _reject_unsafe_path(relative_path: str) -> None:
    path = Path(relative_path)
    lower_name = path.name.lower()
    lower_parts = {part.lower() for part in path.parts}

    if lower_parts & TRANSIENT_COMPONENTS:
        raise PackageHashError(f"transient package path is not allowed: {relative_path}")
    if lower_name == ".ds_store" or lower_name.endswith("~"):
        raise PackageHashError(f"transient package path is not allowed: {relative_path}")
    if path.suffix.lower() in TRANSIENT_SUFFIXES:
        raise PackageHashError(f"transient package path is not allowed: {relative_path}")

    if lower_name in FORBIDDEN_BASENAMES or lower_name.startswith(".env."):
        raise PackageHashError(f"credential-bearing package path is not allowed: {relative_path}")
    if path.suffix.lower() in FORBIDDEN_SUFFIXES:
        raise PackageHashError(f"credential-bearing package path is not allowed: {relative_path}")


def _reject_secret_content(relative_path: str, content: bytes) -> None:
    for label, pattern in SECRET_PATTERNS:
        if pattern.search(content) is not None:
            raise PackageHashError(f"refusing to hash {relative_path}: detected {label}")


def _package_files(root: Path) -> list[Path]:
    if not root.is_dir():
        raise PackageHashError("plugin root must be a directory")
    if not (root / ".codex-plugin" / "plugin.json").is_file():
        raise PackageHashError("plugin root is missing .codex-plugin/plugin.json")

    files: list[Path] = []
    for candidate in root.rglob("*"):
        relative_path = _relative_path(root, candidate)
        _reject_unsafe_path(relative_path)
        mode = candidate.lstat().st_mode
        if stat.S_ISLNK(mode):
            raise PackageHashError(f"symbolic links are not allowed: {relative_path}")
        if stat.S_ISDIR(mode):
            continue
        if not stat.S_ISREG(mode):
            raise PackageHashError(f"non-regular package entry is not allowed: {relative_path}")
        files.append(candidate)

    return sorted(files, key=lambda item: _relative_path(root, item).encode("utf-8"))


def hash_plugin_package(plugin_root: Path) -> PackageHash:
    """Hash paths and bytes, excluding timestamps, ownership, and host file modes."""

    root = plugin_root.expanduser().resolve(strict=True)
    digest = hashlib.sha256(MAGIC)
    file_count = 0
    byte_count = 0

    for file_path in _package_files(root):
        relative_path = _relative_path(root, file_path)
        path_bytes = relative_path.encode("utf-8")
        content = file_path.read_bytes()
        _reject_secret_content(relative_path, content)
        content_digest = hashlib.sha256(content).digest()

        digest.update(len(path_bytes).to_bytes(8, "big"))
        digest.update(path_bytes)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content_digest)
        file_count += 1
        byte_count += len(content)

    return PackageHash(
        sha256=digest.hexdigest(),
        file_count=file_count,
        byte_count=byte_count,
    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compute the canonical secret-safe SHA-256 for a Sophia Voice Lab plugin tree."
    )
    parser.add_argument(
        "plugin_root",
        nargs="?",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Plugin root (defaults to the parent of this scripts directory).",
    )
    parser.add_argument("--json", action="store_true", help="Emit a metadata-only JSON result.")
    parser.add_argument(
        "--check",
        metavar="SHA256",
        help="Exit nonzero unless the computed lowercase SHA-256 exactly matches this value.",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    if args.check is not None and SHA256_RE.fullmatch(args.check) is None:
        print("error: --check must be exactly 64 lowercase hexadecimal characters", file=sys.stderr)
        return 2

    try:
        result = hash_plugin_package(args.plugin_root)
    except (OSError, PackageHashError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(
            json.dumps(
                {
                    "algorithm": ALGORITHM,
                    "byte_count": result.byte_count,
                    "file_count": result.file_count,
                    "sha256": result.sha256,
                },
                sort_keys=True,
                separators=(",", ":"),
            )
        )
    else:
        print(result.sha256)

    if args.check is not None and not hmac.compare_digest(result.sha256, args.check):
        print("error: plugin package SHA-256 mismatch", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
