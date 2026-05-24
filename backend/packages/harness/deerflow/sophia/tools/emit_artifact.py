"""The emit_artifact tool — required on every companion turn.

Carries TTS emotion, session continuity data, and calibration metadata.
Delivered as a tool_use call (never text parsing) to guarantee valid JSON.
"""

from langchain_core.tools import tool

from deerflow.sophia.tools.emit_artifact_contract import ArtifactInput, record_emit_artifact


@tool(args_schema=ArtifactInput, return_direct=True)
def emit_artifact(**kwargs) -> str:
    """REQUIRED ON EVERY TURN. Call this ONCE per turn alongside your spoken response.
    Use this for lightweight Sophia companion/session artifacts: short reflection
    artifacts, session takeaways, emotional or meta-assessments, internal orientation,
    and Presence artifact UI state. If the user asks to create or test a short
    reflection artifact, satisfy it directly with emit_artifact and do not ask a
    reflective follow-up question first. If the user says again or new one after a
    completed artifact, emit exactly one new artifact. Do not start Builder.
    Your spoken response goes in the message content. This tool carries the
    metadata that drives voice emotion, session continuity, and self-improvement.
    The user never sees this raw tool output, though the UI may render the companion artifact.
    IMPORTANT: Call this exactly once per turn. After calling, do NOT call any more tools.
    Your turn is complete after this tool call."""
    return record_emit_artifact(**kwargs)
