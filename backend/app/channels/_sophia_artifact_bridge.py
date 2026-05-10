"""Sophia-services bridge for Telegram channels.

Single point of layer crossing for artifact delivery from
``deerflow.sophia.storage`` into the ``app.channels`` layer. Both
``TelegramChannel`` (EI bot) and ``TelegramWorkChannel`` import from
this bridge instead of reaching into ``deerflow.sophia.*`` directly.

Why centralise:

- The ``deerflow.sophia.storage.supabase_artifact_store.download_artifact``
  call is needed by both Telegram channels for the same purpose: download
  builder-generated artifact bytes and stream them to Telegram via
  ``send_document``. Before this bridge, both channels imported the
  function independently — two cross-layer edges (app_gateway →
  deerflow_sophia_services) plus duplicated knowledge of where the
  function lives.
- Routing both channels through this module collapses two cross-layer
  edges into one and gives us one place to put a future swap (e.g.,
  signed-URL delivery in Stage 2 or a different storage backend).

Public API:

- ``download_artifact(thread_id, filename) -> tuple[bytes, str] | None``

  Re-export of the underlying Sophia-services function. Same signature,
  same behavior. The bridge does NOT add caching, retry, or any other
  policy — it's a thin import-graph indirection.

Spec note: this module's existence is the Phase-C cleanup of the
``Builder-as-Main`` PR. The architectural cleanup plan (in the project
plan file) explicitly called out that touching ``telegram.py`` for the
one-line import substitution requires user sign-off on relaxing the
spec D2 ("EI Telegram channel untouched in Stage 1") to allow this
literal-no-behavior-change re-route. Sign-off was granted.
"""

from __future__ import annotations

from deerflow.sophia.storage.supabase_artifact_store import download_artifact

__all__ = ["download_artifact"]
