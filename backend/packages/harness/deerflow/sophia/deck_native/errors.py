from __future__ import annotations


class DeckNativeError(RuntimeError):
    """Base exception for native deck substrate wrapper failures."""


class DeckNativePathError(DeckNativeError):
    """Raised when a wrapper path argument is unsafe or unsupported."""
