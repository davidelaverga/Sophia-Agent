"""Integration tests for the full Sophia middleware chain.

Tests the chain end-to-end by running middlewares in order against
realistic state, verifying ordering constraints and crisis fast-path.
"""

import asyncio
import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from langchain.agents import create_agent
from langchain.chat_models.base import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import BaseTool


def _make_runtime(**context_kwargs):
    runtime = MagicMock()
    runtime.context = {"thread_id": "test-thread", "platform": "voice", **context_kwargs}
    return runtime


def _make_message(content: str, msg_type: str = "human"):
    msg = MagicMock()
    msg.content = content
    msg.type = msg_type
    return msg


class _SingleToolCallModel(BaseChatModel):
    def __init__(self, tool_name: str, tool_args: dict[str, Any], content: str = ""):
        super().__init__()
        self._tool_name = tool_name
        self._tool_args = tool_args
        self._content = content

    @property
    def _llm_type(self) -> str:
        return "single-tool-call"

    def bind_tools(self, tools: Sequence[dict[str, Any] | type | BaseTool], *args, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        message = AIMessage(
            content=self._content,
            tool_calls=[{
                "name": self._tool_name,
                "id": f"call-{self._tool_name}",
                "args": self._tool_args,
            }],
        )
        return ChatResult(generations=[ChatGeneration(message=message)])


class TestMiddlewareChainOrdering:
    """Verify the chain fires in correct order and produces expected state."""

    @pytest.fixture
    def skills_path(self, tmp_path):
        """Create a minimal skills directory for testing."""
        sp = tmp_path / "sophia"
        sp.mkdir()
        (sp / "soul.md").write_text("# Soul\nYou are Sophia.")
        (sp / "voice.md").write_text("# Voice\nSpeak gently.")
        (sp / "techniques.md").write_text("# Techniques\nUse reflective listening.")
        (sp / "artifact_instructions.md").write_text("# Artifacts\nEmit artifact every turn.")

        # Tone guidance with proper band format
        (sp / "tone_guidance.md").write_text(
            "## Band 1: Shutdown\n**band_id: shutdown**\nGentle.\n\n"
            "## Band 2: Grief/Fear\n**band_id: grief_fear**\nValidate.\n\n"
            "## Band 3: Anger\n**band_id: anger_antagonism**\nDon't match.\n\n"
            "## Band 4: Engagement\n**band_id: engagement**\nMatch energy.\n\n"
            "## Band 5: Enthusiasm\n**band_id: enthusiasm**\nCelebrate.\n"
        )

        ctx = sp / "context"
        ctx.mkdir()
        (ctx / "life.md").write_text("Life context mode.")
        (ctx / "work.md").write_text("Work context mode.")
        (ctx / "gaming.md").write_text("Gaming context mode.")

        rituals = sp / "rituals"
        rituals.mkdir()
        (rituals / "debrief.md").write_text("Debrief ritual instructions.")

        skills = sp / "skills"
        skills.mkdir()
        for name in ["crisis_redirect", "boundary_holding", "vulnerability_holding",
                      "trust_building", "identity_fluidity_support",
                      "celebrating_breakthrough", "challenging_growth", "active_listening"]:
            (skills / f"{name}.md").write_text(f"# {name}\nSkill instructions.")

        return sp

    def _run_before_agent_chain(self, middlewares, state, runtime):
        """Simulate running before_agent on all middlewares in order.

        Each middleware now explicitly reads and extends system_prompt_blocks,
        so we use last-write-wins (dict merge) here.
        """
        for mw in middlewares:
            if hasattr(mw, "before_agent"):
                result = mw.before_agent(state, runtime)
                if result:
                    # Dict merge (last-write-wins) — middlewares handle
                    # system_prompt_blocks accumulation internally.
                    for key, value in result.items():
                        state[key] = value
        return state

    def test_normal_turn_all_middlewares_fire(self, skills_path):
        """All middlewares contribute to state on a normal turn."""
        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
        from deerflow.agents.sophia_agent.middlewares.context_adaptation import ContextAdaptationMiddleware
        from deerflow.agents.sophia_agent.middlewares.crisis_check import CrisisCheckMiddleware
        from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
        from deerflow.agents.sophia_agent.middlewares.platform_context import PlatformContextMiddleware
        from deerflow.agents.sophia_agent.middlewares.ritual import RitualMiddleware
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
        from deerflow.agents.sophia_agent.middlewares.tone_guidance import ToneGuidanceMiddleware
        from deerflow.agents.sophia_agent.middlewares.turn_count import TurnCountMiddleware

        middlewares = [
            CrisisCheckMiddleware(),
            FileInjectionMiddleware(
                (skills_path / "soul.md", False),
                (skills_path / "voice.md", True),
                (skills_path / "techniques.md", True),
            ),
            PlatformContextMiddleware(),
            TurnCountMiddleware(),
            ToneGuidanceMiddleware(skills_path / "tone_guidance.md"),
            ContextAdaptationMiddleware(skills_path / "context", "life"),
            RitualMiddleware(skills_path / "rituals", None),
            SkillRouterMiddleware(skills_path / "skills"),
            ArtifactMiddleware(skills_path / "artifact_instructions.md"),
        ]

        state = {"messages": [_make_message("I had a stressful day at work")]}
        runtime = _make_runtime(platform="voice")

        state = self._run_before_agent_chain(middlewares, state, runtime)

        # Verify state populated
        assert state.get("platform") == "voice"
        assert state.get("turn_count") == 0
        assert state.get("active_tone_band") == "engagement"  # default
        assert state.get("context_mode") == "life"
        assert state.get("active_ritual") is None
        assert state.get("active_skill") is not None
        assert state.get("skip_expensive") is not True

        # Verify prompt blocks accumulated once each without reducer-driven duplication.
        blocks = state.get("system_prompt_blocks", [])
        assert len(blocks) == 8

        # Check specific content
        block_text = "\n".join(blocks)
        assert "Sophia" in block_text  # from soul.md
        assert "voice" in block_text.lower()  # from platform context
        assert "emit_artifact" in block_text

    def test_crisis_fast_path(self, skills_path):
        """Crisis message activates fast-path — only soul.md + crisis_redirect injected."""
        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware
        from deerflow.agents.sophia_agent.middlewares.context_adaptation import ContextAdaptationMiddleware
        from deerflow.agents.sophia_agent.middlewares.crisis_check import CrisisCheckMiddleware
        from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
        from deerflow.agents.sophia_agent.middlewares.platform_context import PlatformContextMiddleware
        from deerflow.agents.sophia_agent.middlewares.ritual import RitualMiddleware
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware
        from deerflow.agents.sophia_agent.middlewares.tone_guidance import ToneGuidanceMiddleware

        middlewares = [
            CrisisCheckMiddleware(),
            FileInjectionMiddleware(
                (skills_path / "soul.md", False),
                (skills_path / "voice.md", True),
                (skills_path / "techniques.md", True),
            ),
            PlatformContextMiddleware(),
            ToneGuidanceMiddleware(skills_path / "tone_guidance.md"),
            ContextAdaptationMiddleware(skills_path / "context", "life"),
            RitualMiddleware(skills_path / "rituals", None),
            SkillRouterMiddleware(skills_path / "skills"),
            ArtifactMiddleware(skills_path / "artifact_instructions.md"),
        ]

        state = {"messages": [_make_message("I want to kill myself")]}
        runtime = _make_runtime(platform="voice")

        state = self._run_before_agent_chain(middlewares, state, runtime)

        # Crisis flags set
        assert state.get("force_skill") == "crisis_redirect"
        assert state.get("skip_expensive") is True
        assert state.get("active_skill") == "crisis_redirect"

        # Only soul.md + crisis_redirect skill injected, with no duplicated carry-over.
        blocks = state.get("system_prompt_blocks", [])
        assert len(blocks) == 2
        block_text = "\n".join(blocks)
        assert "Sophia" in block_text  # soul.md always injected
        assert "crisis_redirect" in block_text  # skill injected
        # Voice and techniques should NOT be present
        assert "Speak gently" not in block_text  # voice.md skipped
        assert "reflective listening" not in block_text  # techniques.md skipped

    def test_ritual_state_available_for_skill_router(self, skills_path):
        """RitualMiddleware runs before SkillRouter, making ritual context available."""
        from deerflow.agents.sophia_agent.middlewares.ritual import RitualMiddleware
        from deerflow.agents.sophia_agent.middlewares.skill_router import SkillRouterMiddleware

        # Ritual runs first
        ritual_mw = RitualMiddleware(skills_path / "rituals", "debrief")
        skill_mw = SkillRouterMiddleware(skills_path / "skills")

        state = {"messages": [_make_message("Let me think about what worked")]}
        runtime = _make_runtime()

        # Run ritual first, then skill router
        result = ritual_mw.before_agent(state, runtime)
        if result:
            for k, v in result.items():
                state[k] = v

        # Now skill router can see ritual state
        assert state.get("active_ritual") == "debrief"

        result = skill_mw.before_agent(state, runtime)
        assert result is not None
        assert "active_skill" in result

    def test_voice_vs_text_platform(self, skills_path):
        """Different platforms produce different guidance blocks."""
        from deerflow.agents.sophia_agent.middlewares.platform_context import PlatformContextMiddleware

        mw = PlatformContextMiddleware()

        voice_result = mw.before_agent({"messages": []}, _make_runtime(platform="voice"))
        text_result = mw.before_agent({"messages": []}, _make_runtime(platform="text"))

        assert "1-3 sentences" in voice_result["system_prompt_blocks"][0]
        assert "2-5 sentences" in text_result["system_prompt_blocks"][0]

    def test_prompt_assembly_creates_system_message(self, skills_path):
        """PromptAssemblyMiddleware joins all blocks into a system message."""
        from langchain_core.messages import HumanMessage, SystemMessage

        from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware

        mw = PromptAssemblyMiddleware()
        human_msg = HumanMessage(content="hello")
        state = {
            "messages": [human_msg],
            "system_prompt_blocks": [
                "# Soul\nYou are Sophia.",
                "Platform: voice. Respond in 1-3 sentences.",
                "# Active Listening\nSkill instructions.",
            ],
        }

        request = MagicMock()
        request.messages = [human_msg]
        request.state = state
        def _override(**kwargs):
            new_req = MagicMock()
            new_req.messages = kwargs.get("messages", [human_msg])
            new_req.state = state
            return new_req
        request.override = _override

        captured = {}
        def handler(req):
            captured["messages"] = req.messages
            return MagicMock()

        mw.wrap_model_call(request, handler)

        msgs = captured["messages"]
        assert isinstance(msgs[0], SystemMessage)
        assert "Sophia" in msgs[0].content
        assert "voice" in msgs[0].content
        assert "Active Listening" in msgs[0].content

    def test_langgraph_json_registration(self):
        """langgraph.json contains sophia_companion and sophia_builder."""
        project_root = Path(__file__).resolve().parent.parent
        langgraph_path = project_root / "langgraph.json"
        config = json.loads(langgraph_path.read_text())
        assert "sophia_companion" in config["graphs"]
        assert "sophia_builder" in config["graphs"]
        assert "deerflow.agents.sophia_agent:make_sophia_agent" in config["graphs"]["sophia_companion"]


class TestArtifactCompletionLoopTermination:
    def test_companion_artifact_tool_call_ends_loop(self, tmp_path):
        from deerflow.agents.sophia_agent.middlewares.artifact import ArtifactMiddleware, ArtifactState
        from deerflow.sophia.tools.emit_artifact import emit_artifact

        instructions = tmp_path / "artifact_instructions.md"
        instructions.write_text("Instructions", encoding="utf-8")

        agent = create_agent(
            model=_SingleToolCallModel(
                "emit_artifact",
                {
                    "session_goal": "Check in",
                    "active_goal": "Reflect",
                    "next_step": "Keep talking",
                    "takeaway": "User feels heard",
                    "reflection": None,
                    "tone_estimate": 2.4,
                    "tone_target": 2.9,
                    "active_tone_band": "engagement",
                    "skill_loaded": "active_listening",
                    "ritual_phase": "freeform.topic",
                    "voice_emotion_primary": "curious",
                    "voice_emotion_secondary": "calm",
                    "voice_speed": "normal",
                },
                content="I hear you.",
            ),
            tools=[emit_artifact],
            middleware=[ArtifactMiddleware(instructions)],
            state_schema=ArtifactState,
        )

        result = asyncio.run(
            agent.ainvoke(
                {"messages": [HumanMessage(content="Hi Sophia")], "platform": "voice"},
                context={"platform": "voice", "thread_id": "test-thread"},
            )
        )

        assert result["current_artifact"]["session_goal"] == "Check in"
        assert result["current_artifact"]["tone_estimate"] == 2.4

    def test_builder_artifact_tool_call_ends_loop(self):
        from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
            BuilderArtifactMiddleware,
            BuilderArtifactState,
        )
        from deerflow.sophia.tools.emit_builder_artifact import emit_builder_artifact

        agent = create_agent(
            model=_SingleToolCallModel(
                "emit_builder_artifact",
                {
                    "artifact_path": "outputs/doc.md",
                    "artifact_type": "document",
                    "artifact_title": "Doc",
                    "steps_completed": 1,
                    "decisions_made": ["Kept it concise"],
                    "companion_summary": "Created the document.",
                    "companion_tone_hint": "Confident",
                    "user_next_action": "Open it.",
                    "confidence": 0.9,
                },
            ),
            tools=[emit_builder_artifact],
            middleware=[BuilderArtifactMiddleware()],
            state_schema=BuilderArtifactState,
        )

        result = asyncio.run(
            agent.ainvoke(
                {"messages": [HumanMessage(content="Build it")]},
                context={"thread_id": "test-thread"},
            )
        )

        assert result["builder_result"]["artifact_path"] == "outputs/doc.md"
        assert result["builder_result"]["confidence"] == 0.9
