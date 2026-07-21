from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Literal, get_args

import anyio
from pydantic import SecretStr

from deerflow.config.app_config import get_app_config
from deerflow.config.model_route_config import ResolvedModelPlan
from deerflow.models.factory import (
    InternalModelRouteCapability,
    _issue_internal_model_route_capability,
    create_internal_route_chat_model,
)
from deerflow.sophia.deck_design_lift.schemas import DeckRepairCandidate
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes
from deerflow.sophia.deck_quality.strict_schema import strict_model_json_schema
from deerflow.sophia.observability import langsmith_tracing_disabled

_PRIVATE_CALLBACK_OVERRIDE_KEYS = frozenset({"callbacks", "tags", "metadata", "verbose"})
_LOCKED_MODEL_OVERRIDE_KEYS = frozenset(
    {
        "max_completion_tokens",
        "max_retries",
        "output_version",
        "reasoning",
        "store",
        "timeout",
        "use_responses_api",
    }
)
_LOCKED_PROVIDER_PAYLOAD_KEYS = frozenset(
    {
        "extra_body",
        "input",
        "max_output_tokens",
        "model",
        "reasoning",
        "store",
        "stream",
        "text",
    }
)
_REQUIRED_INPUT_TOKEN_COUNT_PAYLOAD_KEYS = frozenset(
    {
        "input",
        "model",
        "reasoning",
        "text",
    }
)
_LOCKED_ROUTE = "deck.repair.executor"
_LOCKED_DEPLOYMENT = "openai-gpt-5-6-sol"
_LOCKED_PROVIDER_MODEL = "gpt-5.6-sol"
_LOCKED_PROFILE = "deck-repair-executor-v1"
_LOCKED_PROFILE_VERSION = "v1"
_LOCKED_REASONING = {
    "effort": "high",
    "mode": "standard",
    "context": "current_turn",
}
_LOCKED_MAX_OUTPUT_TOKENS = 24_000
_LOCKED_TIMEOUT_SECONDS = 360
_DQ_OPENAI_API_KEY_ENV = "SOPHIA_DECK_QUALITY_OPENAI_API_KEY"
SafeProviderErrorType = Literal[
    "APIConnectionError",
    "APIStatusError",
    "APITimeoutError",
    "AuthenticationError",
    "BadRequestError",
    "ConflictError",
    "ContentFilterFinishReasonError",
    "InternalServerError",
    "LengthFinishReasonError",
    "NotFoundError",
    "OutputParserException",
    "PermissionDeniedError",
    "RateLimitError",
    "TimeoutError",
    "UnprocessableEntityError",
    "ValidationError",
]
SafeProviderResponseStatus = Literal[
    "cancelled",
    "completed",
    "failed",
    "in_progress",
    "incomplete",
    "queued",
]
SafeProviderIncompleteReason = Literal[
    "content_filter",
    "max_output_tokens",
]
_SAFE_PROVIDER_ERROR_TYPES = frozenset(get_args(SafeProviderErrorType))
_SAFE_PROVIDER_RESPONSE_STATUSES = frozenset(
    get_args(SafeProviderResponseStatus)
)
_SAFE_PROVIDER_INCOMPLETE_REASONS = frozenset(
    get_args(SafeProviderIncompleteReason)
)
_SAFE_VALIDATION_TOKEN = re.compile(r"^[A-Za-z0-9_.:\[\]-]{1,160}$")


def _safe_validation_issues(error: Exception) -> tuple[str, ...]:
    errors = getattr(error, "errors", None)
    if not callable(errors):
        return ()
    try:
        raw_issues = errors()
    except Exception:
        return ()
    issues: list[str] = []
    for issue in raw_issues[:20] if isinstance(raw_issues, list) else ():
        if not isinstance(issue, dict):
            continue
        loc = issue.get("loc")
        error_type = issue.get("type")
        if not isinstance(loc, (list, tuple)) or not isinstance(error_type, str):
            continue
        value = f"{'.'.join(str(part) for part in loc)}:{error_type}"
        if _SAFE_VALIDATION_TOKEN.fullmatch(value):
            issues.append(value)
    return tuple(issues)


class DeckRepairInvocationError(RuntimeError):
    """Controlled DQ-2 provider failure without raw request or response content."""

    def __init__(
        self,
        code: Literal["repair_unavailable", "structured_output_invalid"],
        *,
        provider_error_type: str | None = None,
        provider_status_code: int | None = None,
        provider_response_status: str | None = None,
        provider_incomplete_reason: str | None = None,
        validation_issues: tuple[str, ...] = (),
    ) -> None:
        self.code = code
        self.provider_error_type = provider_error_type if isinstance(provider_error_type, str) and provider_error_type in _SAFE_PROVIDER_ERROR_TYPES else None
        self.provider_status_code = provider_status_code if isinstance(provider_status_code, int) and not isinstance(provider_status_code, bool) and 100 <= provider_status_code <= 599 else None
        self.provider_response_status = (
            provider_response_status
            if isinstance(provider_response_status, str)
            and provider_response_status in _SAFE_PROVIDER_RESPONSE_STATUSES
            else None
        )
        self.provider_incomplete_reason = (
            provider_incomplete_reason
            if isinstance(provider_incomplete_reason, str)
            and provider_incomplete_reason in _SAFE_PROVIDER_INCOMPLETE_REASONS
            and self.provider_response_status == "incomplete"
            else None
        )
        self.validation_issues = tuple(issue for issue in validation_issues[:20] if isinstance(issue, str) and _SAFE_VALIDATION_TOKEN.fullmatch(issue))
        diagnostic = ",".join(
            value
            for value in (
                self.provider_error_type,
                str(self.provider_status_code) if self.provider_status_code is not None else None,
            )
            if value
        )
        super().__init__(f"{code}:{diagnostic}" if diagnostic else code)


@dataclass(frozen=True, slots=True)
class DeckRepairInvocationMetrics:
    latency_ms: int
    input_tokens: int
    output_tokens: int
    total_tokens: int
    deployment_name: str
    provider: str
    provider_model: str
    route_name: str
    profile_version: str
    plan_hash: str
    payload_hash: str


@dataclass(frozen=True, slots=True)
class DeckRepairInvocationResult:
    candidate: DeckRepairCandidate
    metrics: DeckRepairInvocationMetrics


@dataclass(frozen=True, slots=True)
class DeckRepairInputTokenCount:
    input_tokens: int
    payload_hash: str


@dataclass(frozen=True, slots=True, repr=False)
class PreparedDeckRepairRequest:
    """Memory-only canonical request; repair evidence is intentionally not repr'd."""

    root_async_client: Any = field(repr=False, compare=False)
    provider_payload_json: bytes = field(repr=False, compare=False)
    payload_hash: str
    deployment_name: str
    provider: str
    provider_model: str
    route_name: str
    profile_version: str
    plan_hash: str


def repair_safety_identifier(*, canary_user_id: str) -> str:
    digest = hashlib.sha256(f"DQ-2:{canary_user_id}".encode()).hexdigest()
    return f"dq2-{digest[:60]}"


def _response_schema() -> dict[str, Any]:
    return {
        "name": DeckRepairCandidate.__name__,
        "schema": strict_model_json_schema(DeckRepairCandidate),
        "strict": True,
    }


def _response_usage(response: Any) -> tuple[int, int, int]:
    usage = getattr(response, "usage", None)
    if isinstance(usage, dict):
        values = (
            usage.get("input_tokens"),
            usage.get("output_tokens"),
            usage.get("total_tokens"),
        )
    else:
        values = (
            getattr(usage, "input_tokens", None),
            getattr(usage, "output_tokens", None),
            getattr(usage, "total_tokens", None),
        )
    if any(type(value) is not int or value < 0 for value in values):
        raise TypeError
    input_tokens, output_tokens, total_tokens = values
    if total_tokens != input_tokens + output_tokens or output_tokens > _LOCKED_MAX_OUTPUT_TOKENS:
        raise TypeError
    return input_tokens, output_tokens, total_tokens


def _safe_provider_response_status(response: Any) -> str | None:
    status = getattr(response, "status", None)
    return status if isinstance(status, str) and status in _SAFE_PROVIDER_RESPONSE_STATUSES else None


def _safe_provider_incomplete_reason(response: Any) -> str | None:
    details = getattr(response, "incomplete_details", None)
    reason = (
        details.get("reason")
        if isinstance(details, dict)
        else getattr(details, "reason", None)
    )
    return reason if isinstance(reason, str) and reason in _SAFE_PROVIDER_INCOMPLETE_REASONS else None


class DeckRepairModelInvoker:
    """Two-phase exact-count, one-create DQ-2 Responses API boundary."""

    @staticmethod
    def _admitted_route_capability(
        *,
        plan: ResolvedModelPlan,
        canary_user_id: str,
    ) -> InternalModelRouteCapability:
        if not isinstance(plan, ResolvedModelPlan):
            raise TypeError
        config = get_app_config().deck_design_lift
        if (
            not config.enabled
            or config.mode != "production_canary"
            or config.scope != "canary"
            or canary_user_id not in config.canary_user_ids
            or config.repair_route != _LOCKED_ROUTE
            or config.repair_route != plan.route_name
            or config.repair_profile_version != _LOCKED_PROFILE
            or config.repair_profile_version != plan.profile_name
            or config.max_repair_calls != 1
            or plan.deployment_name != _LOCKED_DEPLOYMENT
            or plan.provider != "openai"
            or plan.provider_model != _LOCKED_PROVIDER_MODEL
            or plan.profile_version != _LOCKED_PROFILE_VERSION
        ):
            raise TypeError
        return _issue_internal_model_route_capability(
            plan,
            purpose="deck_design_lift_repair",
        )

    @staticmethod
    def _model_overrides(
        *,
        plan: ResolvedModelPlan,
        canary_user_id: str,
    ) -> dict[str, Any]:
        overrides = {key: value for key, value in plan.model_overrides.items() if key not in _PRIVATE_CALLBACK_OVERRIDE_KEYS}
        if set(overrides) != _LOCKED_MODEL_OVERRIDE_KEYS:
            raise TypeError
        if (
            overrides["reasoning"] != _LOCKED_REASONING
            or overrides["output_version"] != "responses/v1"
            or overrides["use_responses_api"] is not True
            or overrides["store"] is not False
            or type(overrides["max_completion_tokens"]) is not int
            or overrides["max_completion_tokens"] != _LOCKED_MAX_OUTPUT_TOKENS
            or type(overrides["max_retries"]) is not int
            or overrides["max_retries"] != 0
            or type(overrides["timeout"]) is not int
            or overrides["timeout"] != _LOCKED_TIMEOUT_SECONDS
        ):
            raise TypeError
        overrides["extra_body"] = {"safety_identifier": repair_safety_identifier(canary_user_id=canary_user_id)}
        return overrides

    @staticmethod
    def _scrub_private_callbacks(model: Any) -> None:
        model.callbacks = []
        model.tags = []
        model.metadata = {}
        model.verbose = False

    def _prepare_private_request(
        self,
        *,
        plan: ResolvedModelPlan,
        messages: list[Any],
        canary_user_id: str,
    ) -> PreparedDeckRepairRequest:
        capability = self._admitted_route_capability(
            plan=plan,
            canary_user_id=canary_user_id,
        )
        if not isinstance(messages, list) or not messages:
            raise TypeError
        overrides = self._model_overrides(
            plan=plan,
            canary_user_id=canary_user_id,
        )
        # Admission precedes lookup of the only credential this boundary may use.
        api_key = os.getenv(_DQ_OPENAI_API_KEY_ENV, "").strip()
        if not api_key:
            raise RuntimeError("DQ-2 provider credential is unavailable")
        model = create_internal_route_chat_model(
            plan=plan,
            capability=capability,
            attach_tracing=False,
            api_key=SecretStr(api_key),
            **overrides,
        )
        self._scrub_private_callbacks(model)
        get_payload = getattr(model, "_get_request_payload", None)
        if not callable(get_payload):
            raise TypeError
        response_schema = _response_schema()
        payload = get_payload(
            messages,
            response_format={
                "type": "json_schema",
                "json_schema": response_schema,
            },
        )
        if not isinstance(payload, dict) or set(payload) != _LOCKED_PROVIDER_PAYLOAD_KEYS:
            raise TypeError
        if payload.get("model") != _LOCKED_PROVIDER_MODEL:
            raise TypeError
        if payload.get("stream") is not False or payload.get("store") is not False:
            raise TypeError
        if payload.get("max_output_tokens") != _LOCKED_MAX_OUTPUT_TOKENS:
            raise TypeError
        if payload.get("reasoning") != _LOCKED_REASONING:
            raise TypeError
        if payload.get("extra_body") != {"safety_identifier": repair_safety_identifier(canary_user_id=canary_user_id)}:
            raise TypeError
        if "conversation" in payload or "previous_response_id" in payload:
            raise TypeError
        expected_text = {
            "format": {
                "type": "json_schema",
                **response_schema,
            }
        }
        if payload.get("text") != expected_text:
            raise TypeError
        if not isinstance(payload.get("input"), list) or not payload["input"]:
            raise TypeError
        root_async_client = getattr(model, "root_async_client", None)
        responses = getattr(root_async_client, "responses", None)
        input_tokens = getattr(responses, "input_tokens", None)
        if root_async_client is None or not callable(getattr(responses, "create", None)) or not callable(getattr(input_tokens, "count", None)):
            raise TypeError
        provider_payload_json = canonical_json_bytes(payload)
        return PreparedDeckRepairRequest(
            root_async_client=root_async_client,
            provider_payload_json=provider_payload_json,
            payload_hash=hashlib.sha256(provider_payload_json).hexdigest(),
            deployment_name=plan.deployment_name,
            provider=plan.provider,
            provider_model=plan.provider_model,
            route_name=plan.route_name,
            profile_version=plan.profile_version,
            plan_hash=plan.plan_hash,
        )

    def prepare_request(
        self,
        *,
        plan: ResolvedModelPlan,
        messages: list[Any],
        canary_user_id: str,
    ) -> PreparedDeckRepairRequest:
        """Prepare the only token-bearing request without calling the provider."""

        try:
            with langsmith_tracing_disabled():
                return self._prepare_private_request(
                    plan=plan,
                    messages=messages,
                    canary_user_id=canary_user_id,
                )
        except DeckRepairInvocationError:
            raise
        except Exception as error:
            raise DeckRepairInvocationError(
                "repair_unavailable",
                provider_error_type=type(error).__name__,
                provider_status_code=getattr(error, "status_code", None),
            ) from None

    @staticmethod
    def _decode_request(request: PreparedDeckRepairRequest) -> dict[str, Any]:
        if not isinstance(request, PreparedDeckRepairRequest) or hashlib.sha256(request.provider_payload_json).hexdigest() != request.payload_hash:
            raise TypeError
        payload = json.loads(request.provider_payload_json)
        if not isinstance(payload, dict) or set(payload) != _LOCKED_PROVIDER_PAYLOAD_KEYS or canonical_json_bytes(payload) != request.provider_payload_json:
            raise TypeError
        return payload

    @staticmethod
    def _validate_prepared_plan(
        request: PreparedDeckRepairRequest,
        plan: ResolvedModelPlan,
    ) -> None:
        if (
            not isinstance(plan, ResolvedModelPlan)
            or request.deployment_name != plan.deployment_name
            or request.provider != plan.provider
            or request.provider_model != plan.provider_model
            or request.route_name != plan.route_name
            or request.profile_version != plan.profile_version
            or request.plan_hash != plan.plan_hash
        ):
            raise TypeError

    async def count_input_tokens(
        self,
        *,
        request: PreparedDeckRepairRequest,
    ) -> DeckRepairInputTokenCount:
        """Count the exact generation payload without creating a response."""

        try:
            with langsmith_tracing_disabled():
                payload = self._decode_request(request)
                count_payload = {key: payload[key] for key in _REQUIRED_INPUT_TOKEN_COUNT_PAYLOAD_KEYS}
                count = request.root_async_client.responses.input_tokens.count
                with anyio.fail_after(_LOCKED_TIMEOUT_SECONDS):
                    response = await count(
                        **count_payload,
                        timeout=_LOCKED_TIMEOUT_SECONDS,
                    )
        except DeckRepairInvocationError:
            raise
        except Exception as error:
            raise DeckRepairInvocationError(
                "repair_unavailable",
                provider_error_type=type(error).__name__,
                provider_status_code=getattr(error, "status_code", None),
            ) from None
        input_tokens = getattr(response, "input_tokens", None)
        if type(input_tokens) is not int or input_tokens < 0:
            raise DeckRepairInvocationError("repair_unavailable") from None
        return DeckRepairInputTokenCount(
            input_tokens=input_tokens,
            payload_hash=request.payload_hash,
        )

    async def invoke(
        self,
        *,
        request: PreparedDeckRepairRequest,
        plan: ResolvedModelPlan,
        preflight: DeckRepairInputTokenCount,
    ) -> DeckRepairInvocationResult:
        """Create exactly one response from a counted immutable request."""

        try:
            with langsmith_tracing_disabled():
                payload = self._decode_request(request)
                self._validate_prepared_plan(request, plan)
                if not isinstance(preflight, DeckRepairInputTokenCount) or type(preflight.input_tokens) is not int or preflight.input_tokens < 0 or preflight.payload_hash != request.payload_hash:
                    raise DeckRepairInvocationError("structured_output_invalid")
                started = time.monotonic()
                with anyio.fail_after(_LOCKED_TIMEOUT_SECONDS):
                    response = await request.root_async_client.responses.create(
                        **payload,
                        timeout=_LOCKED_TIMEOUT_SECONDS,
                    )
        except DeckRepairInvocationError:
            raise
        except Exception as error:
            provider_error_type = type(error).__name__
            code = (
                "structured_output_invalid"
                if provider_error_type
                in {
                    "ContentFilterFinishReasonError",
                    "LengthFinishReasonError",
                    "OutputParserException",
                    "ValidationError",
                }
                else "repair_unavailable"
            )
            raise DeckRepairInvocationError(
                code,
                provider_error_type=provider_error_type,
                provider_status_code=getattr(error, "status_code", None),
                validation_issues=_safe_validation_issues(error),
            ) from None

        latency_ms = round((time.monotonic() - started) * 1000)
        response_status = _safe_provider_response_status(response)
        incomplete_reason = _safe_provider_incomplete_reason(response)
        if response_status != "completed" or getattr(response, "error", None) is not None:
            raise DeckRepairInvocationError(
                "structured_output_invalid",
                provider_response_status=response_status,
                provider_incomplete_reason=incomplete_reason,
            ) from None
        output_text = getattr(response, "output_text", None)
        if not isinstance(output_text, str) or not output_text:
            raise DeckRepairInvocationError(
                "structured_output_invalid",
                provider_response_status=response_status,
            ) from None
        try:
            candidate = DeckRepairCandidate.model_validate_json(output_text)
            input_tokens, output_tokens, total_tokens = _response_usage(response)
            if input_tokens != preflight.input_tokens:
                raise TypeError
        except Exception as error:
            raise DeckRepairInvocationError(
                "structured_output_invalid",
                provider_error_type=type(error).__name__,
                provider_response_status=response_status,
                validation_issues=_safe_validation_issues(error),
            ) from None
        return DeckRepairInvocationResult(
            candidate=candidate,
            metrics=DeckRepairInvocationMetrics(
                latency_ms=latency_ms,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                total_tokens=total_tokens,
                deployment_name=plan.deployment_name,
                provider=plan.provider,
                provider_model=plan.provider_model,
                route_name=plan.route_name,
                profile_version=plan.profile_version,
                plan_hash=plan.plan_hash,
                payload_hash=request.payload_hash,
            ),
        )
