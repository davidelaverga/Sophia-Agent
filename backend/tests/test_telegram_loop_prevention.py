"""Unit tests for the loop-prevention module (spec §14)."""

from __future__ import annotations

from app.channels.telegram_loop_prevention import (
    ContentDedup,
    InteractionDepthTracker,
    LoopPreventionGate,
    PerSourceRateLimiter,
)


class TestInteractionDepthTracker:
    def test_increment_allows_up_to_max(self) -> None:
        tracker = InteractionDepthTracker(max_depth=3)
        results = [tracker.increment(1, 10) for _ in range(3)]
        depths = [r[0] for r in results]
        allowed = [r[1] for r in results]
        assert depths == [1, 2, 3]
        assert allowed == [True, True, True]

    def test_increment_blocks_after_max(self) -> None:
        tracker = InteractionDepthTracker(max_depth=2)
        tracker.increment(1, 10)
        tracker.increment(1, 10)
        depth, allowed = tracker.increment(1, 10)
        assert depth == 3
        assert allowed is False

    def test_distinct_roots_have_separate_counts(self) -> None:
        tracker = InteractionDepthTracker(max_depth=2)
        tracker.increment(1, 10)
        tracker.increment(1, 10)
        depth, allowed = tracker.increment(1, 11)
        assert depth == 1
        assert allowed is True


class TestPerSourceRateLimiter:
    def test_burst_immediately_allowed(self) -> None:
        limiter = PerSourceRateLimiter(rate_per_second=0.1, burst=3)
        assert all(limiter.allow(100) for _ in range(3))
        assert limiter.allow(100) is False

    def test_distinct_sources_have_distinct_buckets(self) -> None:
        limiter = PerSourceRateLimiter(rate_per_second=0.1, burst=1)
        assert limiter.allow(100) is True
        assert limiter.allow(101) is True


class TestContentDedup:
    def test_identical_text_dropped_within_window(self) -> None:
        dedup = ContentDedup(window_seconds=60)
        assert dedup.is_duplicate(1, 2, "hello") is False
        assert dedup.is_duplicate(1, 2, "hello") is True

    def test_normalisation_collapses_whitespace_and_case(self) -> None:
        dedup = ContentDedup(window_seconds=60)
        assert dedup.is_duplicate(1, 2, "  Hello   World  ") is False
        assert dedup.is_duplicate(1, 2, "hello world") is True

    def test_different_chat_not_duplicate(self) -> None:
        dedup = ContentDedup(window_seconds=60)
        assert dedup.is_duplicate(1, 2, "x") is False
        assert dedup.is_duplicate(99, 2, "x") is False

    def test_empty_text_not_duplicate(self) -> None:
        dedup = ContentDedup()
        assert dedup.is_duplicate(1, 2, "") is False
        assert dedup.is_duplicate(1, 2, "") is False


class TestLoopPreventionGate:
    def test_clean_pass(self) -> None:
        gate = LoopPreventionGate(
            depth=InteractionDepthTracker(max_depth=10),
            rate=PerSourceRateLimiter(rate_per_second=10, burst=10),
            dedup=ContentDedup(),
        )
        decision = gate.check(chat_id=1, root_message_id=10, source_bot_id=100, text="hello")
        assert decision.allow is True
        assert decision.blocked_rule is None

    def test_depth_block(self) -> None:
        gate = LoopPreventionGate(
            depth=InteractionDepthTracker(max_depth=1),
            rate=PerSourceRateLimiter(rate_per_second=10, burst=10),
            dedup=ContentDedup(),
        )
        # First message passes (depth = 1)
        ok = gate.check(chat_id=1, root_message_id=10, source_bot_id=100, text="hi-1")
        assert ok.allow is True
        # Second message exceeds (depth = 2 > 1)
        blocked = gate.check(chat_id=1, root_message_id=10, source_bot_id=100, text="hi-2")
        assert blocked.allow is False
        assert blocked.blocked_rule == "depth"

    def test_rate_block(self) -> None:
        gate = LoopPreventionGate(
            depth=InteractionDepthTracker(max_depth=10),
            rate=PerSourceRateLimiter(rate_per_second=0.001, burst=1),
            dedup=ContentDedup(),
        )
        ok = gate.check(chat_id=1, root_message_id=10, source_bot_id=100, text="m1")
        assert ok.allow is True
        blocked = gate.check(chat_id=1, root_message_id=10, source_bot_id=100, text="m2")
        assert blocked.allow is False
        assert blocked.blocked_rule == "rate"

    def test_dedup_block(self) -> None:
        gate = LoopPreventionGate(
            depth=InteractionDepthTracker(max_depth=10),
            rate=PerSourceRateLimiter(rate_per_second=10, burst=10),
            dedup=ContentDedup(window_seconds=60),
        )
        ok = gate.check(chat_id=1, root_message_id=10, source_bot_id=100, text="same")
        assert ok.allow is True
        blocked = gate.check(chat_id=1, root_message_id=10, source_bot_id=100, text="same")
        assert blocked.allow is False
        assert blocked.blocked_rule == "dedup"
