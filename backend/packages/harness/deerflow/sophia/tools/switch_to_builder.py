"""switch_to_builder tool.

Delegates a task to the sophia_builder agent (DeerFlow's lead_agent)
after the companion has gathered all clarifying information.
"""

from typing import Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field


class SwitchToBuilderInput(BaseModel):
    task: str = Field(description="Complete task description with all clarified specs.")
    task_type: Literal["frontend", "presentation", "research", "document", "visual_report"] = Field(
        description="Type of builder task."
    )


@tool(args_schema=SwitchToBuilderInput)
def switch_to_builder(task: str, task_type: str) -> str:
    """Delegate to builder mode when user asks to BUILD, CREATE, RESEARCH, or MAKE
    something requiring file creation or multi-step execution.
    Do NOT call for emotional conversation, reflection, or memory tasks.
    Before calling this, ensure you have complete specs — ask any clarifying
    questions first, then delegate with the complete brief."""
    # Builder delegation via DeerFlow's task() mechanism will be wired
    # during integration. For now, return acknowledgment.
    return f"Builder task queued: [{task_type}] {task}"
