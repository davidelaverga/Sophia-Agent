from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ModelConfig(BaseModel):
    """Config section for a model"""

    name: str = Field(..., description="Unique name for the model")
    display_name: str | None = Field(..., default_factory=lambda: None, description="Display name for the model")
    description: str | None = Field(..., default_factory=lambda: None, description="Description for the model")
    use: str = Field(
        ...,
        description="Class path of the model provider(e.g. langchain_openai.ChatOpenAI)",
    )
    model: str = Field(..., description="Model name")
    access_scope: Literal["public", "route_only"] = Field(
        default="public",
        description=(
            "Selection surface for this deployment. route_only deployments are "
            "excluded from public discovery and generic/user model selection."
        ),
    )
    provider: str | None = Field(default=None, description="Validated provider metadata; never passed to the model constructor")
    capabilities: set[str] = Field(default_factory=set, description="Stable application-level model capabilities")
    model_config = ConfigDict(extra="allow")
    supports_thinking: bool = Field(default_factory=lambda: False, description="Whether the model supports thinking")
    supports_reasoning_effort: bool = Field(default_factory=lambda: False, description="Whether the model supports reasoning effort")
    when_thinking_enabled: dict | None = Field(
        default_factory=lambda: None,
        description="Extra settings to be passed to the model when thinking is enabled",
    )
    supports_vision: bool = Field(default_factory=lambda: False, description="Whether the model supports vision/image inputs")
    thinking: dict | None = Field(
        default_factory=lambda: None,
        description=(
            "Thinking settings for the model. If provided, these settings will be passed to the model when thinking is enabled. "
            "This is a shortcut for `when_thinking_enabled` and will be merged with `when_thinking_enabled` if both are provided."
        ),
    )
