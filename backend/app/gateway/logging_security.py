"""Credential-safe gateway logging configuration."""

from __future__ import annotations

import logging
import re

_TELEGRAM_BOT_URL_RE = re.compile(r"https://api\.telegram\.org/bot[^/\s]+", re.IGNORECASE)
_AUTHORIZATION_RE = re.compile(r"(?i)(authorization(?:\"|')?\s*[:=]\s*(?:\"|')?(?:bearer\s+)?)[^\s,;\"']+")


def redact_gateway_log_message(value: str) -> str:
    redacted = _TELEGRAM_BOT_URL_RE.sub("https://api.telegram.org/bot[REDACTED]", value)
    return _AUTHORIZATION_RE.sub(r"\1[REDACTED]", redacted)


class CredentialRedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        rendered = record.getMessage()
        redacted = redact_gateway_log_message(rendered)
        if redacted != rendered:
            record.msg = redacted
            record.args = ()
        return True


def install_gateway_logging_safety() -> None:
    redaction_filter = CredentialRedactionFilter()
    root_logger = logging.getLogger()
    for handler in root_logger.handlers:
        if not any(isinstance(item, CredentialRedactionFilter) for item in handler.filters):
            handler.addFilter(redaction_filter)
    for logger_name in ("httpx", "httpcore"):
        logging.getLogger(logger_name).setLevel(logging.WARNING)
