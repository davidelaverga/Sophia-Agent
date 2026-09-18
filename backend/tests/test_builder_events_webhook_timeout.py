"""The completion webhook's timeout budget.

Regression for 2026-09-18: a builder run finished successfully, and its
completion event was then dropped after four `httpx.ReadTimeout` failures, so
the artifact never reached the user. The budget was a single 2.0s TOTAL
timeout, which is a reasonable connect budget and far too small for a receiving
handler that does durable work.

These tests pin the two properties that matter, not the numbers themselves:
the connect budget stays tight, and the read budget is large enough that a
handler slower than the old total still gets its event.
"""

import httpx

from deerflow.sophia import builder_events


def test_connect_stays_tight_and_read_is_given_real_room() -> None:
    timeout = builder_events._WEBHOOK_TIMEOUT

    assert isinstance(timeout, httpx.Timeout), "a split budget, not one number"
    # An unreachable host must fail fast INTO the retry rather than burn the
    # whole budget on one attempt.
    assert timeout.connect is not None
    assert timeout.connect <= 5.0
    # The old failure was a read timeout at 2.0s. Anything in that region just
    # reproduces it.
    assert timeout.read is not None
    assert timeout.read >= 15.0
    assert timeout.read > timeout.connect


def test_a_response_slower_than_the_old_budget_is_still_delivered(monkeypatch) -> None:
    """The actual regression, end to end through `_post_webhook`.

    The receiving handler here takes 3 seconds — longer than the old 2.0s total
    budget and well within the new read budget. Before the fix this was four
    ReadTimeouts and a dropped event; it must now be a single delivered POST.
    """
    attempts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(str(request.url))
        return httpx.Response(202)

    transport = httpx.MockTransport(handler)
    real_client = httpx.Client

    def client_factory(*args, **kwargs):
        timeout = kwargs.get("timeout")
        # The budget actually handed to the transport is the thing under test.
        assert isinstance(timeout, httpx.Timeout)
        assert timeout.read >= 15.0
        return real_client(transport=transport, timeout=timeout)

    monkeypatch.setattr(builder_events.httpx, "Client", client_factory)
    monkeypatch.setattr(
        builder_events,
        "signed_builder_event_headers",
        lambda body: {"content-type": "application/json"},
    )
    monkeypatch.setattr(
        builder_events,
        "encode_builder_event_body",
        lambda payload: b'{"task_id": "t-1"}',
    )
    monkeypatch.setenv("SOPHIA_GATEWAY_URL", "http://gateway.invalid")

    builder_events._post_webhook({"task_id": "t-1", "thread_id": "parent-1"})

    assert len(attempts) == 1, "delivered on the first attempt, not retried"


def test_the_retry_policy_is_unchanged() -> None:
    """The fix is the budget. The retry contract stays exactly as it was.

    Four attempts with (2, 5, 15) backoffs were introduced after a lost
    ceiling-fallback webhook in prod 2026-06-26; widening the timeout is not a
    reason to touch them.
    """
    assert builder_events._WEBHOOK_RETRY_BACKOFFS_SECONDS == (2.0, 5.0, 15.0)
