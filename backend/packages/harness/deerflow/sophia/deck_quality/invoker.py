from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Literal, TypeVar

import anyio
from pydantic import BaseModel

from deerflow.config.model_route_config import ResolvedModelPlan
from deerflow.models.factory import create_chat_model
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes
from deerflow.sophia.deck_quality.strict_schema import strict_model_json_schema
from deerflow.sophia.observability import langsmith_tracing_disabled

T = TypeVar("T", bound=BaseModel)
_PRIVATE_CALLBACK_OVERRIDE_KEYS = frozenset({"callbacks", "tags", "metadata", "verbose"})
_REQUIRED_INPUT_TOKEN_COUNT_PAYLOAD_KEYS = frozenset(
    {
        "input",
        "model",
        "reasoning",
        "text",
    }
)
_NON_COUNT_PROVIDER_PAYLOAD_KEYS = frozenset(
    {
        "extra_body",
        "max_output_tokens",
        "store",
        "stream",
    }
)
_LOCKED_PROVIDER_PAYLOAD_KEYS = _REQUIRED_INPUT_TOKEN_COUNT_PAYLOAD_KEYS | _NON_COUNT_PROVIDER_PAYLOAD_KEYS
_LOCKED_PROVIDER_MODEL = "gpt-5.6-sol"
_LOCKED_REASONING = {
    "effort": "high",
    "mode": "standard",
    "context": "current_turn",
}
_LOCKED_MAX_OUTPUT_TOKENS = 6000
_SAFE_PROVIDER_ERROR_TYPES = frozenset(
    {
        "APIConnectionError",
        "APIStatusError",
        "APITimeoutError",
        "AuthenticationError",
        "BadRequestError",
        "ConflictError",
        "InternalServerError",
        "LengthFinishReasonError",
        "NotFoundError",
        "OutputParserException",
        "PermissionDeniedError",
        "RateLimitError",
        "TimeoutError",
        "UnprocessableEntityError",
        "ValidationError",
        "ContentFilterFinishReasonError",
    }
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


class QualityInvocationError(RuntimeError):
    """Controlled provider failure that never retains raw provider content."""

    def __init__(
        self,
        code: Literal["judge_unavailable", "structured_output_invalid"],
        *,
        provider_error_type: str | None = None,
        provider_status_code: int | None = None,
        validation_issues: tuple[str, ...] = (),
    ) -> None:
        self.code = code
        self.provider_error_type = provider_error_type if provider_error_type in _SAFE_PROVIDER_ERROR_TYPES else None
        self.provider_status_code = provider_status_code if isinstance(provider_status_code, int) and 100 <= provider_status_code <= 599 else None
        self.validation_issues = tuple(issue for issue in validation_issues[:20] if isinstance(issue, str) and _SAFE_VALIDATION_TOKEN.fullmatch(issue))
        diagnostic = ",".join(
            value
            for value in (
                self.provider_error_type,
                str(self.provider_status_code) if self.provider_status_code else None,
            )
            if value
        )
        super().__init__(f"{code}:{diagnostic}" if diagnostic else code)


@dataclass(frozen=True)
class QualityInvocationMetrics:
    latency_ms: int
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    deployment_name: str
    provider: str
    provider_model: str
    route_name: str
    profile_version: str
    plan_hash: str
    preflight_input_tokens: int
    preflight_payload_hash: str


@dataclass(frozen=True)
class QualityInputTokenCount:
    input_tokens: int
    payload_hash: str


@dataclass(frozen=True, slots=True, repr=False)
class PreparedQualityRequest[T: BaseModel]:
    """Memory-only canonical provider request; raw evidence is never repr'd."""

    root_async_client: Any = field(repr=False, compare=False)
    schema: type[T] = field(repr=False, compare=False)
    provider_payload_json: bytes = field(repr=False, compare=False)
    payload_hash: str


@dataclass(frozen=True)
class QualityInvocationResult[T: BaseModel]:
    parsed: T
    metrics: QualityInvocationMetrics


def safety_identifier(*, campaign_id: str, canary_user_id: str) -> str:
    digest = hashlib.sha256(f"{campaign_id}:{canary_user_id}".encode()).hexdigest()
    # OpenAI caps safety_identifier at 64 characters. Retain a namespaced,
    # pseudonymous 240-bit digest without exposing the canary identity.
    return f"dq1-{digest[:60]}"


def _response_usage(response: Any) -> tuple[int | None, int | None, int | None]:
    usage = getattr(response, "usage", None)
    if isinstance(usage, dict):
        input_tokens = usage.get("input_tokens")
        output_tokens = usage.get("output_tokens")
        total_tokens = usage.get("total_tokens")
    else:
        input_tokens = getattr(usage, "input_tokens", None)
        output_tokens = getattr(usage, "output_tokens", None)
        total_tokens = getattr(usage, "total_tokens", None)
    return (
        input_tokens if type(input_tokens) is int else None,
        output_tokens if type(output_tokens) is int else None,
        total_tokens if type(total_tokens) is int else None,
    )


class MultimodalStructuredModelInvoker:
    """Strict provider-routed invocation for DQ-1; no provider client is constructed here."""

    @staticmethod
    def _overrides(
        *,
        plan: ResolvedModelPlan,
        campaign_id: str,
        canary_user_id: str,
    ) -> dict[str, Any]:
        overrides = {key: value for key, value in plan.model_overrides.items() if key not in _PRIVATE_CALLBACK_OVERRIDE_KEYS}
        extra_body = dict(overrides.pop("extra_body", {}) or {})
        extra_body["safety_identifier"] = safety_identifier(
            campaign_id=campaign_id,
            canary_user_id=canary_user_id,
        )
        overrides["extra_body"] = extra_body
        return overrides

    @staticmethod
    def _response_schema(schema: type[T]) -> dict[str, Any]:
        return {
            "name": schema.__name__,
            "schema": strict_model_json_schema(schema),
            "strict": True,
        }

    @classmethod
    def _provider_response_format(cls, schema: type[T]) -> dict[str, Any]:
        return {
            "type": "json_schema",
            "json_schema": cls._response_schema(schema),
        }

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
        schema: type[T],
        messages: list[Any],
        campaign_id: str,
        canary_user_id: str,
    ) -> PreparedQualityRequest[T]:
        """Build and validate the one token-bearing request representation.

        Both the count endpoint and inference derive from this representation.
        Unknown request keys fail closed because a newly introduced key may alter
        tokenization and would otherwise invalidate the cost proof.
        """

        overrides = self._overrides(
            plan=plan,
            campaign_id=campaign_id,
            canary_user_id=canary_user_id,
        )
        model = create_chat_model(
            plan.deployment_name,
            attach_tracing=False,
            **overrides,
        )
        self._scrub_private_callbacks(model)
        get_payload = getattr(model, "_get_request_payload", None)
        if not callable(get_payload):
            raise TypeError
        response_format = self._provider_response_format(schema)
        payload = get_payload(messages, response_format=response_format)
        if not isinstance(payload, dict):
            raise TypeError
        if set(payload) != _LOCKED_PROVIDER_PAYLOAD_KEYS:
            raise TypeError
        if payload.get("model") != _LOCKED_PROVIDER_MODEL:
            raise TypeError
        if payload.get("stream") is not False or payload.get("store") is not False:
            raise TypeError
        if payload.get("max_output_tokens") != _LOCKED_MAX_OUTPUT_TOKENS:
            raise TypeError
        if payload.get("reasoning") != _LOCKED_REASONING:
            raise TypeError
        expected_safety_identifier = safety_identifier(
            campaign_id=campaign_id,
            canary_user_id=canary_user_id,
        )
        if payload.get("extra_body") != {"safety_identifier": expected_safety_identifier}:
            raise TypeError
        if "conversation" in payload or "previous_response_id" in payload:
            raise TypeError
        expected_text_format = {
            "format": {
                "type": "json_schema",
                **self._response_schema(schema),
            }
        }
        if payload.get("text") != expected_text_format:
            raise TypeError
        if not isinstance(payload.get("input"), list) or not payload["input"]:
            raise TypeError
        root_async_client = getattr(model, "root_async_client", None)
        if root_async_client is None:
            raise TypeError
        provider_payload_json = canonical_json_bytes(payload)
        return PreparedQualityRequest(
            root_async_client=root_async_client,
            schema=schema,
            provider_payload_json=provider_payload_json,
            payload_hash=hashlib.sha256(provider_payload_json).hexdigest(),
        )

    def prepare_request(
        self,
        *,
        plan: ResolvedModelPlan,
        schema: type[T],
        messages: list[Any],
        campaign_id: str,
        canary_user_id: str,
    ) -> PreparedQualityRequest[T]:
        try:
            with langsmith_tracing_disabled():
                return self._prepare_private_request(
                    plan=plan,
                    schema=schema,
                    messages=messages,
                    campaign_id=campaign_id,
                    canary_user_id=canary_user_id,
                )
        except QualityInvocationError:
            raise
        except Exception as error:
            raise QualityInvocationError(
                "judge_unavailable",
                provider_error_type=type(error).__name__,
                provider_status_code=getattr(error, "status_code", None),
            ) from None

    @staticmethod
    def _decode_request(request: PreparedQualityRequest[T]) -> dict[str, Any]:
        if hashlib.sha256(request.provider_payload_json).hexdigest() != request.payload_hash:
            raise TypeError
        payload = json.loads(request.provider_payload_json)
        if not isinstance(payload, dict) or set(payload) != _LOCKED_PROVIDER_PAYLOAD_KEYS:
            raise TypeError
        return payload

    async def count_input_tokens(
        self,
        *,
        request: PreparedQualityRequest[T],
        timeout_seconds: int,
    ) -> QualityInputTokenCount:
        """Return the provider's exact full-payload input count before judging.

        The Responses token-count endpoint accepts the same messages, images,
        reasoning settings, and strict output schema as the generation call.
        It does not create a model response, so it is safe to repeat before the
        durable provider-call fence. Any count failure prevents generation.
        """

        try:
            with langsmith_tracing_disabled():
                payload = self._decode_request(request)
                count_payload = {key: payload[key] for key in _REQUIRED_INPUT_TOKEN_COUNT_PAYLOAD_KEYS}
                count = request.root_async_client.responses.input_tokens.count
                with anyio.fail_after(timeout_seconds):
                    response = await count(
                        **count_payload,
                        timeout=timeout_seconds,
                    )
        except QualityInvocationError:
            raise
        except Exception as error:
            raise QualityInvocationError(
                "judge_unavailable",
                provider_error_type=type(error).__name__,
                provider_status_code=getattr(error, "status_code", None),
            ) from None
        input_tokens = getattr(response, "input_tokens", None)
        if type(input_tokens) is not int or input_tokens < 0:
            raise QualityInvocationError("judge_unavailable") from None
        return QualityInputTokenCount(
            input_tokens=input_tokens,
            payload_hash=request.payload_hash,
        )

    async def invoke(
        self,
        *,
        request: PreparedQualityRequest[T],
        plan: ResolvedModelPlan,
        timeout_seconds: int,
        preflight: QualityInputTokenCount,
    ) -> QualityInvocationResult[T]:
        # These messages contain base64 render evidence and raw plan bodies, which
        # DQ-1 forbids sending to LangSmith. Suppress both the factory-attached
        # callback and environment/context-driven tracing for the entire call.
        # The quality graph emits a separate hash/count-only trace.
        try:
            with langsmith_tracing_disabled():
                payload = self._decode_request(request)
                if request.payload_hash != preflight.payload_hash:
                    raise QualityInvocationError("structured_output_invalid")
                started = time.monotonic()
                with anyio.fail_after(timeout_seconds):
                    response = await request.root_async_client.responses.create(
                        **payload,
                        timeout=timeout_seconds,
                    )
        except QualityInvocationError:
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
                else "judge_unavailable"
            )
            raise QualityInvocationError(
                code,
                provider_error_type=provider_error_type,
                provider_status_code=getattr(error, "status_code", None),
                validation_issues=_safe_validation_issues(error),
            ) from None
        latency_ms = round((time.monotonic() - started) * 1000)
        if getattr(response, "status", None) != "completed" or getattr(response, "error", None) is not None:
            raise QualityInvocationError("structured_output_invalid") from None
        output_text = getattr(response, "output_text", None)
        if not isinstance(output_text, str) or not output_text:
            raise QualityInvocationError("structured_output_invalid") from None
        try:
            parsed = request.schema.model_validate_json(output_text)
        except Exception as error:
            raise QualityInvocationError(
                "structured_output_invalid",
                provider_error_type=type(error).__name__,
                validation_issues=_safe_validation_issues(error),
            ) from None
        input_tokens, output_tokens, total_tokens = _response_usage(response)
        if input_tokens != preflight.input_tokens:
            raise QualityInvocationError("structured_output_invalid") from None
        return QualityInvocationResult(
            parsed=parsed,
            metrics=QualityInvocationMetrics(
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
                preflight_input_tokens=preflight.input_tokens,
                preflight_payload_hash=preflight.payload_hash,
            ),
        )
