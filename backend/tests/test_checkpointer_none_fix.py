"""Test for issue #1016: checkpointer should not return None."""

from unittest.mock import MagicMock, patch

import pytest
from langgraph.checkpoint.memory import InMemorySaver


class TestCheckpointerNoneFix:
    """Tests that checkpointer context managers return InMemorySaver instead of None."""

    @pytest.mark.anyio
    async def test_async_make_checkpointer_returns_in_memory_saver_when_not_configured(self):
        """make_checkpointer should return InMemorySaver when config.checkpointer is None."""
        from deerflow.agents.checkpointer.async_provider import make_checkpointer

        startup_config = object()
        with (
            patch(
                "deerflow.agents.checkpointer.async_provider.get_app_config",
                return_value=startup_config,
            ),
            patch(
                "deerflow.agents.checkpointer.async_provider.audit_deck_quality_builder_service_startup",
            ) as startup_audit,
            patch(
                "deerflow.agents.checkpointer.async_provider._get_active_checkpointer_config",
                return_value=None,
            ),
        ):
            async with make_checkpointer() as checkpointer:
                # Should return InMemorySaver, not None
                assert checkpointer is not None
                assert isinstance(checkpointer, InMemorySaver)

                # Should be able to call alist() without AttributeError
                # This is what LangGraph does and what was failing in issue #1016
                result = []
                async for item in checkpointer.alist(config={"configurable": {"thread_id": "test"}}):
                    result.append(item)

                # Empty list is expected for a fresh checkpointer
                assert result == []
        startup_audit.assert_called_once_with(config=startup_config)

    @pytest.mark.anyio
    async def test_dq_audit_failure_prevents_langgraph_lifespan_readiness(self):
        """The configured checkpointer context is entered before /ok is ready."""
        from deerflow.agents.checkpointer.async_provider import make_checkpointer
        from deerflow.sophia.build_runtime.startup import BuildFoundationStartupError

        startup_config = object()
        with (
            patch(
                "deerflow.agents.checkpointer.async_provider.get_app_config",
                return_value=startup_config,
            ),
            patch(
                "deerflow.agents.checkpointer.async_provider.audit_deck_quality_builder_service_startup",
                side_effect=BuildFoundationStartupError("DQ startup unavailable"),
            ) as startup_audit,
            patch(
                "deerflow.agents.checkpointer.async_provider._get_active_checkpointer_config",
            ) as checkpointer_config,
            pytest.raises(
                BuildFoundationStartupError,
                match="DQ startup unavailable",
            ),
        ):
            async with make_checkpointer():
                raise AssertionError("failed startup must not yield readiness")

        startup_audit.assert_called_once_with(config=startup_config)
        checkpointer_config.assert_not_called()

    def test_sync_checkpointer_context_returns_in_memory_saver_when_not_configured(self):
        """checkpointer_context should return InMemorySaver when config.checkpointer is None."""
        from deerflow.agents.checkpointer.provider import checkpointer_context

        # Mock get_app_config to return a config with checkpointer=None
        mock_config = MagicMock()
        mock_config.checkpointer = None

        with patch("deerflow.agents.checkpointer.provider.get_app_config", return_value=mock_config):
            with checkpointer_context() as checkpointer:
                # Should return InMemorySaver, not None
                assert checkpointer is not None
                assert isinstance(checkpointer, InMemorySaver)

                # Should be able to call list() without AttributeError
                result = list(checkpointer.list(config={"configurable": {"thread_id": "test"}}))

                # Empty list is expected for a fresh checkpointer
                assert result == []
