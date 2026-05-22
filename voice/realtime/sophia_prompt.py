from __future__ import annotations

import ast
from functools import cache, lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SKILLS_PATH = REPO_ROOT / "skills" / "public" / "sophia"
SOPHIA_AGENT_MIDDLEWARE_PATH = (
    REPO_ROOT
    / "backend"
    / "packages"
    / "harness"
    / "deerflow"
    / "agents"
    / "sophia_agent"
    / "middlewares"
)

CORE_SKILL_FILES = (
    SKILLS_PATH / "soul.md",
    SKILLS_PATH / "voice.md",
    SKILLS_PATH / "techniques.md",
    SKILLS_PATH / "AGENTS.md",
)

GEMINI_LIVE_SPOKEN_TURN_POLICY_SOURCE = (
    "voice/realtime/sophia_prompt.py::build_gemini_live_spoken_turn_policy_overlay"
)
REALTIME_MEMORY_RECALL_GUIDANCE_SOURCE = (
    "voice/realtime/sophia_prompt.py::build_realtime_memory_recall_guidance"
)

_REALTIME_MEMORY_RECALL_GUIDANCE = """<realtime_memory_recall_guidance>
Memory recall and epistemic honesty:
- For explicit memory questions, use retrieve_memories unless the answer is already clearly in setup context or the current conversation.
- Broad recall and later specific recall are separate opportunities.
    If the user asks "what do you remember about me?" and later asks "do you remember my favorite childhood movie?", make a new focused memory call unless that fact was already retrieved or spoken earlier.
- Do not call retrieve_memories for simple greetings, hearing checks, current-turn facts, generic advice, or "what is my name?" when the preferred name is already present in setup context.
- Stored memory: use "I have this stored as...", "I remember that...", or "I have a memory that..."
    only when a matching retrieved memory or explicit setup seed fact supports it.
- Setup context: for identity, handoff, or profile context loaded at session start, say "I have this context from earlier..." or "What I have going into this session is...".
- Current-session context: when the user just said something, say "You just told me...", "For this session, I've got that...", or "I'll keep that in mind here."
    New facts from this live conversation are not durable memory until offline writeback confirms them.
    You may use them during this live session, but do not promise permanent memory, long-term storage, or future recall.
- Inference or guess: when reasoning from hints, say "My guess would be...", "That sounds like it might be...", or "I'm inferring, not remembering...".
- Missing memory: when retrieve_memories returns no_results, say "I don't have that stored" or "I don't see that in memory." Do not imply memory is broken.
- Unavailable memory: when retrieval is unavailable or errors, say "Memory retrieval isn't available right now" or "I can't check stored memory at the moment." Do not say the memory does not exist.
- After a user reveals or corrects an answer that was not retrieved, never say "I knew it", "I remembered that", "I had that", "I knew it had to be", "Of course, I remember", or "That's what I had stored".
    Say it is something you have for this session, not something you had stored.
</realtime_memory_recall_guidance>"""

_GEMINI_LIVE_SPOKEN_TURN_POLICY_OVERLAY = """<gemini_live_spoken_turn_policy>
You are speaking in live audio. This Gemini Live-specific overlay has high priority for spoken output.

Spoken turn contract:
- Keep the spoken response focused and stop cleanly.
- Choose one main conversational intent per assistant turn.
- Answer the user's immediate intent first.
- Ask at most one question total in the spoken reply.
- Do not repeat an opener, stack opener questions, or ask the same clarification in different words.
- Do not assume the user is gaming, working, preparing, or starting a session from a generic greeting, hearing check, or connection check.
- Use gaming, ritual, or session-prep context only when the user explicitly introduced it in the current turn or the immediately preceding user context clearly established it.
- For hearing or availability checks, reply with a brief acknowledgement, then stop or ask one neutral next-step prompt. Do not ask whether they are ready for a game, session, or lock-in unless they already mentioned that.
- For recommendation or focus prompts, if context is missing ask one clarifier only; if context is present give one concise recommendation. Do not do both.
- Do not combine multiple focus clarifiers such as what they are doing, what they want to improve, whether it is work or gaming, and "tell me more" in one spoken turn.
- For reflection or deictic requests like "what I just said" or "that," resolve the reference to the latest complete user utterance or latest clearly stated phrase, not the whole broader topic.
- If the latest user utterance is only filler or setup, such as "quick question before I go," "um," "like," "one more thing," or "before I leave," look one user utterance earlier for the meaningful content.
- Answer reflection requests directly and briefly. Do not ask "what do you want me to focus on?" unless the antecedent is genuinely missing, and do not summarize the whole conversation unless the user asks for a recap.
- If a setup phrase is followed by an actionable request in the same turn, answer the actionable request, not the setup phrase as the main intent.
- If a setup phrase is captured as its own separate turn, acknowledge lightly and do not reset the topic or start a new session agenda.
- For emotional or coaching turns, give one clear point and one optional next step. Do not reframe the same point multiple ways.
- Keep artifact/tool obligations in structured tool calls. Do not narrate artifact fields, session goals, tone estimates, ritual phases, or internal bookkeeping.
- Do not let artifact or tool instructions expand the spoken reply, and do not mention artifact bookkeeping aloud.
- After satisfying the user's immediate intent and any required structured tool behavior, stop.
- If unsure, be shorter and let the user guide the next step.

Compact examples:
User: "Can you hear me clearly?"
Good: "Yes, loud and clear. What's on your mind?"
Good: "Yes, I can hear you clearly."
Bad: "Yes, loud and clear. What's up? Are you getting ready for something? What are you heading into right now?"
Bad: "Yeah, loud and clear. You getting ready for a game? Loud and clear. Ready to lock in?"

User: "What should I focus on today?"
Good: "What kind of day are you heading into?"
Good if context is known: "Focus on staying calm under pressure. Pick one cue phrase and return to it when things get tense."
Bad: "What are you doing today? What do you want to get out of it? Is it work, gaming, or something else? Tell me more."

Recent user context: "I'm better than this. I'm in control."
User: "Reflect briefly on what I just said."
Good: "That cue works because it brings you back to control instead of panic. Use it the moment pressure starts rising."
Bad: "What do you want me to focus on?"
Bad: "You asked about game recommendations, and we settled on staying calm under pressure."

User: "Quick question before I go... um... reflect briefly on what I just said."
Good: Answer the reflection request using the latest meaningful user content.
Bad: Treat "quick question before I go" as the full request or start a new opener.
</gemini_live_spoken_turn_policy>"""


def build_sophia_realtime_instructions(
    *,
    platform: str = "voice",
    context_mode: str = "life",
    ritual: str | None = None,
) -> str:
    """Build provider-native realtime instructions from Sophia's existing prompt sources."""
    blocks: list[str] = [_read_prompt_file(path) for path in CORE_SKILL_FILES]
    blocks.append(_platform_prompt(platform))

    context_block = _context_prompt(context_mode)
    if context_block:
        blocks.append(context_block)

    ritual_block = _ritual_prompt(ritual)
    if ritual_block:
        blocks.append(ritual_block)

    blocks.append(build_realtime_memory_recall_guidance())
    blocks.append(_voice_artifact_instructions())
    return "\n\n---\n\n".join(block.strip() for block in blocks if block.strip())


def build_gemini_live_realtime_instructions(
    *,
    platform: str = "voice",
    context_mode: str = "life",
    ritual: str | None = None,
) -> str:
    """Build Gemini Live instructions with a provider-specific spoken policy overlay."""
    blocks = [
        build_sophia_realtime_instructions(
            platform=platform,
            context_mode=context_mode,
            ritual=ritual,
        ),
        build_gemini_live_spoken_turn_policy_overlay(),
    ]
    return "\n\n---\n\n".join(block.strip() for block in blocks if block.strip())


def build_gemini_live_spoken_turn_policy_overlay() -> str:
    """Return Gemini Live's spoken-turn policy overlay."""
    return _GEMINI_LIVE_SPOKEN_TURN_POLICY_OVERLAY


def build_realtime_memory_recall_guidance() -> str:
    """Return realtime memory routing and epistemic-honesty guidance."""
    return _REALTIME_MEMORY_RECALL_GUIDANCE


def sophia_realtime_instruction_sources(
    *,
    platform: str = "voice",
    context_mode: str = "life",
    ritual: str | None = None,
) -> list[str]:
    """Return human-readable source labels for prompt parity tests and docs."""
    sources = [path.relative_to(REPO_ROOT).as_posix() for path in CORE_SKILL_FILES]
    sources.append(
        "backend/packages/harness/deerflow/agents/sophia_agent/middlewares/"
        "platform_context.py::PLATFORM_PROMPTS"
    )

    context_path = _context_path(context_mode)
    if context_path is not None:
        sources.append(context_path.relative_to(REPO_ROOT).as_posix())

    ritual_path = _ritual_path(ritual)
    if ritual_path is not None:
        sources.append(ritual_path.relative_to(REPO_ROOT).as_posix())

    sources.append(REALTIME_MEMORY_RECALL_GUIDANCE_SOURCE)
    sources.append(
        "backend/packages/harness/deerflow/agents/sophia_agent/middlewares/"
        "artifact.py::_VOICE_ARTIFACT_INSTRUCTIONS"
    )
    return sources


def gemini_live_realtime_instruction_sources(
    *,
    platform: str = "voice",
    context_mode: str = "life",
    ritual: str | None = None,
) -> list[str]:
    """Return source labels for Gemini Live prompt parity tests and docs."""
    return [
        *sophia_realtime_instruction_sources(
            platform=platform,
            context_mode=context_mode,
            ritual=ritual,
        ),
        GEMINI_LIVE_SPOKEN_TURN_POLICY_SOURCE,
    ]


@lru_cache(maxsize=1)
def _platform_prompts() -> dict[str, str]:
    value = _module_literal_assignment(
        SOPHIA_AGENT_MIDDLEWARE_PATH / "platform_context.py",
        "PLATFORM_PROMPTS",
    )
    if not isinstance(value, dict):
        raise ValueError("Sophia platform prompt source did not contain PLATFORM_PROMPTS.")
    return {str(key): str(prompt) for key, prompt in value.items()}


def _platform_prompt(platform: str) -> str:
    prompts = _platform_prompts()
    return prompts.get(platform, prompts["voice"])


def _context_prompt(context_mode: str) -> str | None:
    path = _context_path(context_mode)
    if path is None:
        return None
    return _read_prompt_file(path)


def _context_path(context_mode: str) -> Path | None:
    normalized = context_mode if context_mode in {"work", "gaming", "life"} else "life"
    path = SKILLS_PATH / "context" / f"{normalized}.md"
    return path if path.exists() else None


def _ritual_prompt(ritual: str | None) -> str | None:
    path = _ritual_path(ritual)
    if path is None:
        return None
    return _read_prompt_file(path)


def _ritual_path(ritual: str | None) -> Path | None:
    if not ritual:
        return None
    normalized = ritual.strip().lower()
    if normalized not in {"prepare", "debrief", "vent", "reset"}:
        return None
    path = SKILLS_PATH / "rituals" / f"{normalized}.md"
    return path if path.exists() else None


@lru_cache(maxsize=1)
def _voice_artifact_instructions() -> str:
    value = _module_literal_assignment(
        SOPHIA_AGENT_MIDDLEWARE_PATH / "artifact.py",
        "_VOICE_ARTIFACT_INSTRUCTIONS",
    )
    if not isinstance(value, str):
        raise ValueError("Sophia artifact prompt source did not contain voice instructions.")
    return value


@cache
def _read_prompt_file(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _module_literal_assignment(path: Path, name: str) -> object:
    module = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in module.body:
        if not isinstance(node, ast.Assign):
            continue
        if any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            return ast.literal_eval(node.value)
    raise ValueError(f"Could not find literal assignment {name!r} in {path}.")