"""The emit_artifact tool — required on every companion turn.

Carries TTS emotion, session continuity data, and calibration metadata.
Delivered as a tool_use call (never text parsing) to guarantee valid JSON.
"""

from langchain_core.tools import tool

from deerflow.sophia.tools.emit_artifact_contract import ArtifactInput, record_emit_artifact


@tool(args_schema=ArtifactInput, return_direct=True)
def emit_artifact(**kwargs) -> str:
    """REQUIRED ON EVERY TURN. Call this ONCE per turn alongside your spoken response.
    Your spoken response goes in the message content. This tool carries the
    metadata that drives voice emotion, session continuity, and self-improvement.
    The user never sees this output.
    IMPORTANT: Call this exactly once per turn. After calling, do NOT call any more tools.
    Your turn is complete after this tool call."""
    return record_emit_artifact(**kwargs)
