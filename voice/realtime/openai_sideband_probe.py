from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from voice.realtime.openai_browser_dogfood import (
    OPENAI_REALTIME_API_KEY_ENV,
    _connect_openai_sideband_websocket,
    _extract_websocket_http_status,
    _extract_websocket_request_id,
    _truncate_for_log,
    build_openai_sideband_ws_urls,
    is_valid_openai_call_id,
)


@dataclass(frozen=True)
class OpenAISidebandProbeResult:
    call_id: str
    url: str
    ok: bool
    elapsed_ms: int
    status_code: int | None = None
    request_id: str | None = None
    error_type: str | None = None
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "call_id": self.call_id,
            "url": self.url,
            "ok": self.ok,
            "elapsed_ms": self.elapsed_ms,
            "status_code": self.status_code,
            "request_id": self.request_id,
            "error_type": self.error_type,
            "error": self.error,
        }


async def probe_openai_sideband_attach(
    *,
    call_id: str,
    api_key: str,
    timeout_seconds: float = 10.0,
    websockets_module: Any | None = None,
) -> OpenAISidebandProbeResult:
    if not is_valid_openai_call_id(call_id):
        raise ValueError("Expected the rtc_* call id from the OpenAI WebRTC Location header.")
    if not api_key.strip():
        raise ValueError(f"{OPENAI_REALTIME_API_KEY_ENV} is required for the sideband probe.")

    url = build_openai_sideband_ws_urls(call_id=call_id)[0]
    headers = {"Authorization": f"Bearer {api_key}"}
    started_at = time.monotonic()

    if websockets_module is None:
        try:
            import websockets as websockets_module  # type: ignore[import-not-found,no-redef]
        except ImportError as exc:
            raise RuntimeError("The optional 'websockets' package is required for the sideband probe.") from exc

    try:
        websocket = await asyncio.wait_for(
            _connect_openai_sideband_websocket(
                websockets_module,
                url=url,
                headers=headers,
            ),
            timeout=timeout_seconds,
        )
    except Exception as exc:
        elapsed_ms = int((time.monotonic() - started_at) * 1000)
        return OpenAISidebandProbeResult(
            call_id=call_id,
            url=url,
            ok=False,
            elapsed_ms=elapsed_ms,
            status_code=_extract_websocket_http_status(exc),
            request_id=_extract_websocket_request_id(exc),
            error_type=exc.__class__.__name__,
            error=_truncate_for_log(str(exc)),
        )

    elapsed_ms = int((time.monotonic() - started_at) * 1000)
    await _close_probe_websocket(websocket)
    return OpenAISidebandProbeResult(
        call_id=call_id,
        url=url,
        ok=True,
        elapsed_ms=elapsed_ms,
    )


async def _close_probe_websocket(websocket: Any) -> None:
    close = getattr(websocket, "close", None)
    if callable(close):
        result = close()
        if hasattr(result, "__await__"):
            await result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Probe OpenAI Realtime sideband attach for an existing WebRTC rtc_* call id.",
    )
    parser.add_argument("call_id", help="The rtc_* id from the OpenAI WebRTC Location header.")
    parser.add_argument(
        "--api-key-env",
        default=OPENAI_REALTIME_API_KEY_ENV,
        help="Environment variable containing the standard OpenAI API key.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=10.0,
        help="WebSocket handshake timeout.",
    )
    args = parser.parse_args(argv)

    api_key = os.getenv(args.api_key_env, "")
    try:
        result = asyncio.run(
            probe_openai_sideband_attach(
                call_id=args.call_id,
                api_key=api_key,
                timeout_seconds=args.timeout_seconds,
            )
        )
    except Exception as exc:
        print(
            json.dumps(
                {
                    "call_id": args.call_id,
                    "url": build_openai_sideband_ws_urls(call_id=args.call_id)[0]
                    if is_valid_openai_call_id(args.call_id)
                    else None,
                    "ok": False,
                    "elapsed_ms": 0,
                    "status_code": None,
                    "request_id": None,
                    "error_type": exc.__class__.__name__,
                    "error": _truncate_for_log(str(exc)),
                },
                indent=2,
            )
        )
        return 2

    print(json.dumps(result.as_dict(), indent=2))
    return 0 if result.ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
