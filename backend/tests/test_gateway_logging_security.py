from __future__ import annotations

import logging

from app.gateway.logging_security import CredentialRedactionFilter, redact_gateway_log_message


def test_gateway_log_redaction_removes_telegram_token_and_authorization() -> None:
    source = "POST https://api.telegram.org/bot123456:secret-value/sendMessage Authorization: Bearer private-token"
    redacted = redact_gateway_log_message(source)

    assert "secret-value" not in redacted
    assert "private-token" not in redacted
    assert "bot[REDACTED]/sendMessage" in redacted
    assert "Authorization: Bearer [REDACTED]" in redacted


def test_gateway_log_filter_redacts_formatted_arguments() -> None:
    record = logging.LogRecord(
        "httpx",
        logging.INFO,
        __file__,
        1,
        "request %s",
        ("https://api.telegram.org/botabc/sendMessage",),
        None,
    )

    assert CredentialRedactionFilter().filter(record) is True
    assert record.args == ()
    assert record.getMessage() == "request https://api.telegram.org/bot[REDACTED]/sendMessage"
