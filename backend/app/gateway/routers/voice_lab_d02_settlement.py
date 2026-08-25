"""Gateway-owned D02 browser-worker termination settlement authority.

The deployment controller is deliberately not an authority on product zero.
Before Render is touched, the owning Voice-Lab service freezes the exact
Gateway/session/provider/browser envelope under the cleanup advisory key.  A
later settlement succeeds only after the canonical browser receipts, a
Voice-authored terminal receipt, provider-admission zero, and Gateway relay
zero all agree with that immutable freeze.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

router = APIRouter(prefix="/internal/voice-lab/d02", tags=["voice-lab-d02"])

D02_CAPABILITY_HEADER = "X-Sophia-Voice-Lab-D02-Gateway-Capability"
D02_CAPABILITY_ISSUER = "sophia-voice-lab"
D02_CAPABILITY_AUDIENCE = "sophia-gateway-d02-settlement"
D02_RECEIPT_AUDIENCE = "sophia-voice-lab-d02-gateway-settlement"
D02_RECEIPT_ISSUER = "sophia-gateway"
D02_FREEZE_SCHEMA = (
    "sophia_voice_lab_gateway_browser_worker_termination_freeze_request_v1"
)
D02_SETTLEMENT_REQUEST_SCHEMA = (
    "sophia_voice_lab_gateway_browser_worker_termination_settlement_request_v1"
)
D02_SETTLEMENT_SCHEMA = (
    "sophia_voice_lab_gateway_browser_worker_termination_settlement_v1"
)
D02_CONTINUITY_REQUEST_SCHEMA = (
    "sophia_voice_lab_d02_product_continuity_observation_request_v1"
)
D02_CONTINUITY_SCHEMA = "sophia_voice_lab_d02_product_continuity_observation_v1"
D02_VOICE_TERMINAL_SCHEMA = "sophia_voice_lab_voice_provider_terminal_v1"
D02_VOICE_TERMINAL_ISSUER = "sophia-voice"
D02_VOICE_TERMINAL_AUDIENCE = "sophia-gateway-d02-terminal"

_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_SHA1 = re.compile(r"^[a-f0-9]{40}$")
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_CLEANUP_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_CAPABILITY_MAX_TTL_SECONDS = 300
_CLOCK_SKEW_SECONDS = 10
_CONTINUITY_OBSERVATION_MAX_AGE = timedelta(minutes=5)
_RECEIPT_TTL = timedelta(minutes=15)
_RELAY_LEASE_SECONDS = 30
_LOCAL_LOCK = threading.RLock()
_LOCAL_FREEZES: dict[tuple[str, str], dict[str, Any]] = {}
_LOCAL_CONTINUITY_OBSERVATIONS: dict[tuple[str, str, str], dict[str, Any]] = {}
_LOCAL_RELAY_LEASES: dict[str, dict[str, Any]] = {}
_LOCAL_CAPABILITY_USES: dict[str, tuple[str, str, str, str]] = {}
_GATEWAY_RELAY_OWNER_INSTANCE_ID_SHA256 = hashlib.sha256(
    secrets.token_bytes(32)
).hexdigest()
_D02_CLEANUP_MIGRATION_SHA256 = (
    "191ee955123259b821d5dd87b03579ce912f3467376b58316cbfac855ce83b44"
)
_D02_COLUMNS = {
    "sophia_voice_lab_d02_gateway_finalize_authority": (
        ("singleton", "bool", "NO", None, "true"),
        ("authority_key_id", "text", "NO", None, ""),
        ("authority_secret", "text", "NO", None, ""),
        ("installed_at", "timestamptz", "NO", None, "clock_timestamp()"),
    ),
    "sophia_voice_lab_d02_gateway_capability_uses": (
        ("capability_jti_sha256", "bpchar", "NO", 64, ""),
        ("operation", "text", "NO", None, ""),
        ("request_sha256", "bpchar", "NO", 64, ""),
        ("cleanup_obligation_id", "text", "NO", None, ""),
        ("termination_request_id_sha256", "bpchar", "NO", 64, ""),
        ("used_at", "timestamptz", "NO", None, "clock_timestamp()"),
    ),
    "sophia_voice_lab_d02_gateway_relay_leases": (
        ("relay_id", "uuid", "NO", None, ""),
        ("cleanup_obligation_id", "text", "NO", None, ""),
        ("provider_session_id", "text", "NO", None, ""),
        ("provider_connection_epoch", "int4", "NO", None, ""),
        ("relay_kind", "text", "NO", None, ""),
        ("owner_instance_id_sha256", "bpchar", "NO", 64, ""),
        ("expires_at", "timestamptz", "NO", None, ""),
        ("created_at", "timestamptz", "NO", None, "clock_timestamp()"),
    ),
    "sophia_voice_lab_d02_gateway_settlements": (
        ("cleanup_obligation_id", "text", "NO", None, ""),
        ("termination_request_id_sha256", "bpchar", "NO", 64, ""),
        ("provider_session_id", "text", "NO", None, ""),
        ("provider_admission_id", "uuid", "NO", None, ""),
        ("freeze_request_sha256", "bpchar", "NO", 64, ""),
        ("freeze_capability_jti_sha256", "bpchar", "NO", 64, ""),
        ("freeze_binding", "jsonb", "NO", None, ""),
        ("frozen_at", "timestamptz", "NO", None, "clock_timestamp()"),
        ("voice_terminal_receipt_sha256", "bpchar", "YES", 64, ""),
        ("voice_terminal_receipt", "jsonb", "YES", None, ""),
        ("voice_terminal_at", "timestamptz", "YES", None, ""),
        ("settlement_request_sha256", "bpchar", "YES", 64, ""),
        ("settlement_capability_jti_sha256", "bpchar", "YES", 64, ""),
        ("provider_settlement_sha256", "bpchar", "YES", 64, ""),
        ("receipt_sha256", "bpchar", "YES", 64, ""),
        ("receipt", "jsonb", "YES", None, ""),
        ("settled_at", "timestamptz", "YES", None, ""),
    ),
    "sophia_voice_lab_d02_product_continuity_observations": (
        ("cleanup_obligation_id", "text", "NO", None, ""),
        ("restart_request_id_sha256", "bpchar", "NO", 64, ""),
        ("phase", "text", "NO", None, ""),
        ("request_sha256", "bpchar", "NO", 64, ""),
        ("capability_jti_sha256", "bpchar", "NO", 64, ""),
        ("product_service_boot_id_sha256", "bpchar", "NO", 64, ""),
        ("render_action_request_sha256", "bpchar", "NO", 64, ""),
        ("prior_observation_receipt_sha256", "bpchar", "YES", 64, ""),
        ("receipt_sha256", "bpchar", "NO", 64, ""),
        ("receipt", "jsonb", "NO", None, ""),
        ("observed_at", "timestamptz", "NO", None, "clock_timestamp()"),
    ),
}
_D02_CONSTRAINTS = {
    "sophia_voice_lab_d02_gateway_capability_uses.sophia_voice_lab_d02_gateway_capabil_cleanup_obligation_id_fkey": ("f", "e4374f2ba313fc85590728355940fa5d2270249cf2cda1b60d416a2df55a7509"),
    "sophia_voice_lab_d02_gateway_capability_uses.sophia_voice_lab_d02_gateway_capability_use_valid": ("c", "6920ab0aa1ace1259c5901074ee0c7e2ddbb35ff742eddcd7ec61f1014656bd7"),
    "sophia_voice_lab_d02_gateway_capability_uses.sophia_voice_lab_d02_gateway_capability_uses_pkey": ("p", "a961c742c7d3457dfcc14036010e5998f624e2de98038905fd2ac348805029b5"),
    "sophia_voice_lab_d02_gateway_finalize_authority.sophia_voice_lab_d02_gateway_finalize_authority_pkey": ("p", "d004b3efcdc4a0108ecbe83c93408f63eebecc563529a3941a4c59667835f25b"),
    "sophia_voice_lab_d02_gateway_finalize_authority.sophia_voice_lab_d02_gateway_finalize_authority_shape": ("c", "72391c6f052baf8359f67736ea44dcdb5c6b5654413920529375ee84656b51e7"),
    "sophia_voice_lab_d02_gateway_finalize_authority.sophia_voice_lab_d02_gateway_finalize_authority_singleton": ("c", "0a780c77dfabbc15def3d17957997d352de196c1233a0d25fccc97a40d2d6f41"),
    "sophia_voice_lab_d02_gateway_relay_leases.sophia_voice_lab_d02_gateway_relay_l_cleanup_obligation_id_fkey": ("f", "e4374f2ba313fc85590728355940fa5d2270249cf2cda1b60d416a2df55a7509"),
    "sophia_voice_lab_d02_gateway_relay_leases.sophia_voice_lab_d02_gateway_relay_lease_valid": ("c", "9255a14b07341568705205a69256eba988d3bd8914538a3d208e0938a51f2323"),
    "sophia_voice_lab_d02_gateway_relay_leases.sophia_voice_lab_d02_gateway_relay_leases_pkey": ("p", "a31d33028f6a44ff6d3875c2f055f964eacd05ded31d5a6ddce3f187dfc07339"),
    "sophia_voice_lab_d02_gateway_settlements.sophia_voice_lab_d02_gateway_settlem_cleanup_obligation_id_fkey": ("f", "e4374f2ba313fc85590728355940fa5d2270249cf2cda1b60d416a2df55a7509"),
    "sophia_voice_lab_d02_gateway_settlements.sophia_voice_lab_d02_gateway_settlement_binding_valid": ("c", "0a15d4341753469bd5a9e8a65e4f02ea6d7cba53860979eb3b1c45e2baad6208"),
    "sophia_voice_lab_d02_gateway_settlements.sophia_voice_lab_d02_gateway_settlement_hashes_valid": ("c", "6a35b3db36ae129559ba5499ea558ed6400123e68ab1210c966044f2e2a6418f"),
    "sophia_voice_lab_d02_gateway_settlements.sophia_voice_lab_d02_gateway_settlement_lifecycle_valid": ("c", "51543a623b2b5d5a5ceaff154cfd1c3aa9deafd601cf93c4da48b3dbd29a82b1"),
    "sophia_voice_lab_d02_gateway_settlements.sophia_voice_lab_d02_gateway_settlements_pkey": ("p", "f32df012404d69382bbd618d48e17658886c6d8a3f764ca63056f762ad35486e"),
    "sophia_voice_lab_d02_product_continuity_observations.sophia_voice_lab_d02_product_continu_cleanup_obligation_id_fkey": ("f", "e4374f2ba313fc85590728355940fa5d2270249cf2cda1b60d416a2df55a7509"),
    "sophia_voice_lab_d02_product_continuity_observations.sophia_voice_lab_d02_product_continuity_hashes_valid": ("c", "ebd2ddd7f2018bad52ea5cddc1112bd1d90cb52c40f28ea3943b52b3f011a683"),
    "sophia_voice_lab_d02_product_continuity_observations.sophia_voice_lab_d02_product_continuity_observations_pkey": ("p", "22bfbe634350aecb7e6653b19040d9d4e66cdde7e258e9375a8bd870d888533f"),
    "sophia_voice_lab_d02_product_continuity_observations.sophia_voice_lab_d02_product_continuity_receipt_valid": ("c", "a2b49334beea375a3d4fa6749d527d33af113bfc04b76a385de7ec2da2e55ff1"),
    "sophia_voice_lab_d02_product_continuity_observations.sophia_voice_lab_d02_product_continuity_shape_valid": ("c", "c2a72e4ec1a177df28000e73c6ac8f98392b4f1f953ca560be8af28724d3283d"),
}
_D02_INDEXES = {
    "sophia_voice_lab_d02_gateway_capability_uses_pkey": ("sophia_voice_lab_d02_gateway_capability_uses", True, 1, ("capability_jti_sha256",), (0,), "", ("bpchar_ops",), ("default",)),
    "sophia_voice_lab_d02_gateway_finalize_authority_pkey": ("sophia_voice_lab_d02_gateway_finalize_authority", True, 1, ("singleton",), (0,), "", ("bool_ops",), ("",)),
    "sophia_voice_lab_d02_gateway_relay_expiry_idx": (
        "sophia_voice_lab_d02_gateway_relay_leases", False, 4,
        ("cleanup_obligation_id", "expires_at", "owner_instance_id_sha256", "relay_id"),
        (0, 0, 0, 0), "", ("text_ops", "timestamptz_ops", "bpchar_ops", "uuid_ops"),
        ("default", "", "default", ""),
    ),
    "sophia_voice_lab_d02_gateway_relay_leases_pkey": ("sophia_voice_lab_d02_gateway_relay_leases", True, 1, ("relay_id",), (0,), "", ("uuid_ops",), ("",)),
    "sophia_voice_lab_d02_gateway_settlements_freeze_jti_idx": ("sophia_voice_lab_d02_gateway_settlements", True, 1, ("freeze_capability_jti_sha256",), (0,), "", ("bpchar_ops",), ("default",)),
    "sophia_voice_lab_d02_gateway_settlements_pkey": ("sophia_voice_lab_d02_gateway_settlements", True, 2, ("cleanup_obligation_id", "termination_request_id_sha256"), (0, 0), "", ("text_ops", "bpchar_ops"), ("default", "default")),
    "sophia_voice_lab_d02_gateway_settlements_settlement_jti_idx": (
        "sophia_voice_lab_d02_gateway_settlements", True, 1,
        ("settlement_capability_jti_sha256",), (0,),
        "settlement_capability_jti_sha256 IS NOT NULL", ("bpchar_ops",),
        ("default",),
    ),
    "sophia_voice_lab_d02_product_continuity_observations_pkey": (
        "sophia_voice_lab_d02_product_continuity_observations", True, 3,
        ("cleanup_obligation_id", "restart_request_id_sha256", "phase"),
        (0, 0, 0), "", ("text_ops", "bpchar_ops", "text_ops"),
        ("default", "default", "default"),
    ),
    "sophia_voice_lab_d02_product_continuity_one_restart_idx": ("sophia_voice_lab_d02_product_continuity_observations", True, 1, ("cleanup_obligation_id",), (0,), "phase = 'before_api_restart'::text", ("text_ops",), ("default",)),
}
_D02_COMMENT_SUFFIXES = {
    "sophia_voice_lab_d02_gateway_settlements": "d02-gateway-settlement.v1 migration_sha256={hash} content=bounded-authority-receipt-no-raw-principal",
    "sophia_voice_lab_d02_gateway_capability_uses": "d02-gateway-capability-use.v1 migration_sha256={hash} content=opaque-replay-binding-only",
    "sophia_voice_lab_d02_gateway_relay_leases": "d02-gateway-relay-lease.v1 migration_sha256={hash} content=opaque-live-relay-authority-only",
    "sophia_voice_lab_d02_product_continuity_observations": "d02-product-continuity-observation.v1 migration_sha256={hash} content=hashed-product-projection-signed-receipt-only",
    "sophia_voice_lab_d02_gateway_finalize_authority": "d02-database-finalize-authority.v1 migration_sha256={hash} content=owner-only-key-material-never-runtime-readable",
}
_D02_GATEWAY_TABLE_PRIVILEGES = {
    table: frozenset() for table in _D02_COLUMNS
}
_D02_FUNCTIONS = {
    "sophia_voice_lab_d02_browser_settlement": (
        "p_metadata jsonb, p_provider_session_id text", "jsonb", "plpgsql",
        "s", False, True, "s",
        "f3e3bc3c27e9d5e28f3e206ebd2230b419463ca117acc024356cec64149b5ffa",
        False, "browser-settlement", "owner-internal",
    ),
    "sophia_voice_lab_d02_canonical_json": (
        "p_value jsonb", "text", "plpgsql", "i", False, True, "s",
        "070913f32577512228d6e87368a7291c378532bb03c181ff4e2fca7f2780cb06",
        False, "canonical-json", "owner-internal",
    ),
    "sophia_voice_lab_d02_continuity_authorize": (
        "p_cleanup_obligation_id text, p_restart_request_id_sha256 text, "
        "p_phase text, p_request_sha256 text, p_capability_jti_sha256 text, "
        "p_observed_at timestamp with time zone",
        "jsonb", "plpgsql", "v", True, False, "u",
        "14b4fc34cf9bf60c66e307c32e8943c1e421197a0633a4486fbf4392901acc56",
        True, "continuity-authorize", "gateway-execute",
    ),
    "sophia_voice_lab_d02_continuity_finalize": (
        "p_cleanup_obligation_id text, p_restart_request_id_sha256 text, "
        "p_phase text, p_request_sha256 text, p_capability_jti_sha256 text, "
        "p_product_service_boot_id_sha256 text, "
        "p_render_action_request_sha256 text, "
        "p_prior_observation_receipt_sha256 text, p_receipt_sha256 text, "
        "p_receipt jsonb, p_authority_key_id text, "
        "p_finalize_proof_sha256 text",
        "jsonb", "plpgsql", "v", True, False, "u",
        "591c5cf7b4fd1af27a0acc9780e1cb95c99209d22c3910b03a0dd4f59881c8f8",
        True, "continuity-finalize", "gateway-execute-hmac",
    ),
    "sophia_voice_lab_d02_finalize_authority_ready": (
        "p_authority_key_id text, p_authority_secret_sha256 text",
        "boolean", "sql", "s", True, True, "s",
        "ce3cfd8a1859c1e703927a3cc907628e6e147563029513354ae9e9ea932c5bf4",
        True, "authority-ready", "gateway-readback",
    ),
    "sophia_voice_lab_d02_finalize_proof_valid": (
        "p_authority_key_id text, p_domain text, p_parts jsonb, "
        "p_value jsonb, p_proof_sha256 text",
        "boolean", "plpgsql", "s", True, True, "r",
        "fd637099a2e026380dd1b4017b8a341811fb9cf6bc58c4ee41c077e8472f9c97",
        False, "finalize-proof-valid", "owner-internal",
    ),
    "sophia_voice_lab_d02_freeze_authorize": (
        "p_cleanup_obligation_id text, p_termination_request_id_sha256 text, "
        "p_request_sha256 text, p_capability_jti_sha256 text",
        "jsonb", "plpgsql", "v", True, False, "u",
        "60d23be11556efb20fb0290c05be5987808ea978ed82a8b3b4bb9f46c175c020",
        True, "freeze-authorize", "gateway-execute",
    ),
    "sophia_voice_lab_d02_freeze_finalize": (
        "p_cleanup_obligation_id text, p_termination_request_id_sha256 text, "
        "p_provider_session_id text, p_provider_admission_id uuid, "
        "p_request_sha256 text, p_capability_jti_sha256 text, "
        "p_freeze_binding jsonb, p_authority_key_id text, "
        "p_finalize_proof_sha256 text",
        "jsonb", "plpgsql", "v", True, False, "u",
        "de3f91905416587285ee54f0f15a8fee7e99bece48999001e7ec9690539e5d4d",
        True, "freeze-finalize", "gateway-execute-hmac",
    ),
    "sophia_voice_lab_d02_hmac_sha256": (
        "p_key bytea, p_data bytea", "bytea", "plpgsql", "i", False, True,
        "s", "03b16bf3f6ce33e09cbb9445f6afe8c343caeaf3fae11cfa526fa7ac641fd3c9",
        False, "hmac-sha256", "owner-internal",
    ),
    "sophia_voice_lab_d02_producer_open": (
        "p_cleanup_obligation_id text", "boolean", "plpgsql", "v", True,
        False, "u",
        "4db750471171dba20a1c71e3a6f73505efca17c93226820129b91c59f183e8a3",
        True, "producer-open", "gateway-readback",
    ),
    "sophia_voice_lab_d02_provider_freeze": (
        "p_cleanup_obligation_id text, p_provider_admission_id uuid, "
        "p_provider_session_id text",
        "jsonb", "plpgsql", "s", True, False, "u",
        "da2c68d664005bc5b630599d6297a3a233a61763975c63344986b6e1c628ac9c",
        True, "provider-freeze", "gateway-readback",
    ),
    "sophia_voice_lab_d02_register_capability_use": (
        "p_capability_jti_sha256 text, p_operation text, "
        "p_request_sha256 text, p_cleanup_obligation_id text, "
        "p_request_id_sha256 text",
        "boolean", "sql", "v", False, False, "u",
        "b964d9481272417056bf53ed7f8864a67071bc0567f627477a4b73f4e6fd4b80",
        False, "capability-use", "owner-internal",
    ),
    "sophia_voice_lab_d02_register_capability_use_state": (
        "p_capability_jti_sha256 text, p_operation text, "
        "p_request_sha256 text, p_cleanup_obligation_id text, "
        "p_request_id_sha256 text",
        "text", "plpgsql", "v", False, False, "u",
        "810a45a17e5a3b934a6ef0b7cddb36ffe46ea83da6725d2f2839748b5253255c",
        False, "capability-state", "owner-internal",
    ),
    "sophia_voice_lab_d02_relay_begin": (
        "p_relay_id uuid, p_cleanup_obligation_id text, "
        "p_provider_session_id text, p_provider_connection_epoch integer, "
        "p_relay_kind text, p_owner_instance_id_sha256 text, "
        "p_lease_seconds integer, p_authority_key_id text, "
        "p_operation_proof_sha256 text",
        "boolean", "plpgsql", "v", True, False, "u",
        "7d5677b2c65e11531338bcc4af05672ad9fc3787986d0fa4365a7652029c3b6e",
        True, "relay-begin", "gateway-execute-hmac",
    ),
    "sophia_voice_lab_d02_relay_end": (
        "p_relay_id uuid, p_cleanup_obligation_id text, "
        "p_owner_instance_id_sha256 text, p_operation_id_sha256 text, "
        "p_authority_key_id text, p_operation_proof_sha256 text",
        "boolean", "plpgsql", "v", True, False, "u",
        "bf089f4e5e55667b9b7902ad5ec4afe5e7c27ceacf0fe9a9ee3ec8accb3f9774",
        True, "relay-end", "gateway-execute-hmac",
    ),
    "sophia_voice_lab_d02_relay_refresh": (
        "p_relay_id uuid, p_cleanup_obligation_id text, "
        "p_owner_instance_id_sha256 text, p_lease_seconds integer, "
        "p_operation_id_sha256 text, p_authority_key_id text, "
        "p_operation_proof_sha256 text",
        "boolean", "plpgsql", "v", True, False, "u",
        "8d6a271cc20516fd476ee56adad82e18094e4fdb4cb0aba467e1eeb83a3a1e0c",
        True, "relay-refresh", "gateway-execute-hmac",
    ),
    "sophia_voice_lab_d02_settlement_authorize": (
        "p_cleanup_obligation_id text, p_termination_request_id_sha256 text, "
        "p_request_sha256 text, p_capability_jti_sha256 text",
        "jsonb", "plpgsql", "v", True, False, "u",
        "06980b6cd70094490d5461c00a22b738f83c5c6cd4b9ba0b6a56cc9d33ff84f9",
        True, "settlement-authorize", "gateway-execute",
    ),
    "sophia_voice_lab_d02_settlement_finalize": (
        "p_cleanup_obligation_id text, p_termination_request_id_sha256 text, "
        "p_provider_session_id text, p_provider_admission_id uuid, "
        "p_request_sha256 text, p_capability_jti_sha256 text, "
        "p_provider_settlement_sha256 text, p_next_metadata jsonb, "
        "p_receipt_sha256 text, p_receipt jsonb, p_authority_key_id text, "
        "p_finalize_proof_sha256 text",
        "jsonb", "plpgsql", "v", True, False, "u",
        "a96754002d924205727f17629fba51c3633b4543954a7e827c724467b88a0096",
        True, "settlement-finalize", "gateway-execute-hmac",
    ),
    "sophia_voice_lab_d02_sources_zero": (
        "p_cleanup_obligation_id text", "boolean", "sql", "s", True,
        False, "u",
        "8c8dd393f5a61e9e0a3b165904b417065a877fd1f5b7485d2a7d8b064e669ccb",
        True, "sources-zero", "gateway-runtime-readback",
    ),
    "sophia_voice_lab_d02_voice_terminal_authorize": (
        "p_cleanup_obligation_id text, p_provider_admission_id uuid, "
        "p_provider_session_id text",
        "jsonb", "plpgsql", "v", True, False, "u",
        "9c094510a8ff27a0fd36ef94922b56746249d72284c5441e61787d5a76c278aa",
        True, "voice-terminal-authorize", "gateway-execute",
    ),
    "sophia_voice_lab_d02_voice_terminal_finalize": (
        "p_cleanup_obligation_id text, p_provider_admission_id uuid, "
        "p_provider_session_id text, p_receipt_sha256 text, p_receipt jsonb, "
        "p_authority_key_id text, p_finalize_proof_sha256 text",
        "jsonb", "plpgsql", "v", True, False, "u",
        "e62bc88c1142478da159500d241ce22e89d8cbbfbcbeb074556228de4d844d80",
        True, "voice-terminal-finalize", "gateway-execute-hmac",
    ),
}


def _failure(code: str, status_code: int) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code})


def _canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _canonical_hash(value: object) -> str:
    encoded = _canonical_json(value).encode("utf-8")
    if len(encoded) > 1_000_000:
        raise _failure("voice_lab_d02_request_too_large", 422)
    return hashlib.sha256(encoded).hexdigest()


def _canonical_utc_millis(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _parse_canonical_utc_millis(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    normalized = parsed.astimezone(UTC)
    return normalized if _canonical_utc_millis(normalized) == value else None


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _require_fresh_continuity_observation(
    observed_at: str,
    *,
    database_now: datetime,
) -> None:
    parsed = _parse_canonical_utc_millis(observed_at)
    if (
        parsed is None
        or parsed > database_now + timedelta(seconds=_CLOCK_SKEW_SECONDS)
        or parsed
        < database_now
        - _CONTINUITY_OBSERVATION_MAX_AGE
        - timedelta(seconds=_CLOCK_SKEW_SECONDS)
    ):
        raise _failure("voice_lab_d02_continuity_observation_stale", 409)


def _uuid4(value: object) -> str | None:
    try:
        parsed = uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None
    canonical = str(parsed)
    return canonical if parsed.version == 4 and canonical == value else None


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class D02FreezeRequest(_StrictModel):
    schema: Literal[
        "sophia_voice_lab_gateway_browser_worker_termination_freeze_request_v1"
    ]
    termination_request_id: str
    voice_lab_run_id_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    test_run_id: str = Field(min_length=1, max_length=128)
    cleanup_obligation_id: str = Field(
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    )
    provider_session_id: str = Field(min_length=1, max_length=256)
    provider_admission_id_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    provider_connection_epoch: int = Field(gt=0)
    frozen_provider_connection_epochs: tuple[int, ...] = Field(
        min_length=1, max_length=64
    )
    browser_worker_id_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    browser_lease_epoch: int = Field(gt=0)
    browser_context_id_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    render_action_request_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    requested_at: str

    @field_validator("termination_request_id")
    @classmethod
    def _validate_termination_id(cls, value: str) -> str:
        if _uuid4(value) is None:
            raise ValueError("termination request id must be canonical UUIDv4")
        return value

    @field_validator("test_run_id")
    @classmethod
    def _validate_test_run_id(cls, value: str) -> str:
        if _uuid4(value) is None:
            raise ValueError("test_run_id must be canonical UUIDv4")
        return value

    @field_validator("provider_session_id")
    @classmethod
    def _validate_provider_session_id(cls, value: str) -> str:
        if not _SAFE_ID.fullmatch(value):
            raise ValueError("provider_session_id must be a canonical ASCII safe id")
        return value

    @field_validator("requested_at")
    @classmethod
    def _validate_requested_at(cls, value: str) -> str:
        if _parse_canonical_utc_millis(value) is None:
            raise ValueError("requested_at must be canonical UTC milliseconds")
        return value

    @model_validator(mode="after")
    def _validate_epochs(self) -> D02FreezeRequest:
        epochs = self.frozen_provider_connection_epochs
        if (
            tuple(sorted(set(epochs))) != epochs
            or self.provider_connection_epoch not in epochs
            or any(epoch <= 0 for epoch in epochs)
        ):
            raise ValueError("frozen epochs must be positive, unique, and ascending")
        return self


class D02SettlementRequest(_StrictModel):
    schema: Literal[
        "sophia_voice_lab_gateway_browser_worker_termination_settlement_request_v1"
    ]
    termination_request_id: str
    voice_lab_run_id_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    test_run_id: str = Field(min_length=1, max_length=128)
    cleanup_obligation_id: str = Field(
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    )
    provider_session_id: str = Field(min_length=1, max_length=256)
    provider_admission_id_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    provider_connection_epoch: int = Field(gt=0)
    frozen_provider_connection_epochs: tuple[int, ...] = Field(
        min_length=1, max_length=64
    )
    browser_worker_id_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    browser_lease_epoch: int = Field(gt=0)
    browser_context_id_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    render_action_request_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    render_action_accepted_response_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    render_action_settled_snapshot_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    loss_event_seq: int = Field(gt=0)
    loss_observed_at: str

    @field_validator("termination_request_id")
    @classmethod
    def _validate_termination_id(cls, value: str) -> str:
        if _uuid4(value) is None:
            raise ValueError("termination request id must be canonical UUIDv4")
        return value

    @field_validator("test_run_id")
    @classmethod
    def _validate_test_run_id(cls, value: str) -> str:
        if _uuid4(value) is None:
            raise ValueError("test_run_id must be canonical UUIDv4")
        return value

    @field_validator("provider_session_id")
    @classmethod
    def _validate_provider_session_id(cls, value: str) -> str:
        if not _SAFE_ID.fullmatch(value):
            raise ValueError("provider_session_id must be a canonical ASCII safe id")
        return value

    @field_validator("loss_observed_at")
    @classmethod
    def _validate_loss_at(cls, value: str) -> str:
        if _parse_canonical_utc_millis(value) is None:
            raise ValueError("loss_observed_at must be canonical UTC milliseconds")
        return value

    @model_validator(mode="after")
    def _validate_epochs(self) -> D02SettlementRequest:
        epochs = self.frozen_provider_connection_epochs
        if (
            tuple(sorted(set(epochs))) != epochs
            or self.provider_connection_epoch not in epochs
            or any(epoch <= 0 for epoch in epochs)
        ):
            raise ValueError("frozen epochs must be positive, unique, and ascending")
        return self


class D02ContinuityObservationRequest(_StrictModel):
    schema: Literal[
        "sophia_voice_lab_d02_product_continuity_observation_request_v1"
    ]
    restart_request_id: str
    cleanup_obligation_id: str = Field(
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    )
    phase: Literal["before_api_restart", "after_api_restart"]
    product_service_boot_id_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    render_action_request_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    prior_observation_receipt_sha256: str | None = Field(
        default=None, pattern=r"^[a-f0-9]{64}$"
    )
    observed_at: str

    @field_validator("restart_request_id")
    @classmethod
    def _validate_restart_id(cls, value: str) -> str:
        if _uuid4(value) is None:
            raise ValueError("restart_request_id must be canonical UUIDv4")
        return value

    @field_validator("observed_at")
    @classmethod
    def _validate_observed_at(cls, value: str) -> str:
        if _parse_canonical_utc_millis(value) is None:
            raise ValueError("observed_at must be canonical UTC milliseconds")
        return value

    @model_validator(mode="after")
    def _validate_phase_chain(self) -> D02ContinuityObservationRequest:
        if (
            self.phase == "before_api_restart"
            and self.prior_observation_receipt_sha256 is not None
        ) or (
            self.phase == "after_api_restart"
            and self.prior_observation_receipt_sha256 is None
        ):
            raise ValueError("continuity phase chain is invalid")
        return self


def _request_dict(body: BaseModel) -> dict[str, Any]:
    value = body.model_dump(mode="json")
    # Pydantic serializes tuples as lists in JSON mode, matching the TypeScript
    # canonical request representation used by the owning product service.
    return dict(value)


def _required_secret(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if len(value.encode("utf-8")) < 32:
        raise _failure("voice_lab_d02_configuration_invalid", 503)
    return value


def _b64url_decode(value: str) -> bytes:
    if not value or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise _failure("voice_lab_d02_capability_malformed", 401)
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, UnicodeEncodeError) as exc:
        raise _failure("voice_lab_d02_capability_malformed", 401) from exc
    if (
        not decoded
        or base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii") != value
    ):
        raise _failure("voice_lab_d02_capability_malformed", 401)
    return decoded


def _verify_capability(
    request: Request,
    *,
    operation: Literal["freeze", "settle", "observe_continuity"],
    request_sha256: str,
    cleanup_obligation_id: str,
    termination_request_id_sha256: str,
) -> str:
    secret = _required_secret("SOPHIA_VOICE_LAB_D02_GATEWAY_CAPABILITY_SECRET")
    token = request.headers.get(D02_CAPABILITY_HEADER)
    if not token:
        raise _failure("voice_lab_d02_capability_required", 401)
    parts = token.split(".")
    if len(parts) != 2:
        raise _failure("voice_lab_d02_capability_malformed", 401)
    encoded, signature = parts
    supplied = _b64url_decode(signature)
    expected = hmac.new(
        secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256
    ).digest()
    if not hmac.compare_digest(supplied, expected):
        raise _failure("voice_lab_d02_capability_invalid_signature", 401)
    try:
        claims = json.loads(_b64url_decode(encoded).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _failure("voice_lab_d02_capability_malformed", 401) from exc
    allowed = {
        "v",
        "iss",
        "aud",
        "op",
        "request_sha256",
        "cleanup_obligation_id",
        "termination_request_id_sha256",
        "iat",
        "nbf",
        "exp",
        "jti",
        "nonce",
    }
    if not isinstance(claims, dict) or set(claims) != allowed:
        raise _failure("voice_lab_d02_capability_malformed", 401)
    now = int(time.time())
    if (
        claims.get("v") != 1
        or claims.get("iss") != D02_CAPABILITY_ISSUER
        or claims.get("aud") != D02_CAPABILITY_AUDIENCE
        or claims.get("op") != operation
        or claims.get("request_sha256") != request_sha256
        or claims.get("cleanup_obligation_id") != cleanup_obligation_id
        or claims.get("termination_request_id_sha256")
        != termination_request_id_sha256
        or not isinstance(claims.get("iat"), int)
        or isinstance(claims.get("iat"), bool)
        or not isinstance(claims.get("nbf"), int)
        or isinstance(claims.get("nbf"), bool)
        or not isinstance(claims.get("exp"), int)
        or isinstance(claims.get("exp"), bool)
        or claims["exp"] <= claims["iat"]
        or claims["exp"] - claims["iat"] > _CAPABILITY_MAX_TTL_SECONDS
        or claims["iat"] > now + _CLOCK_SKEW_SECONDS
        or claims["nbf"] < claims["iat"] - _CLOCK_SKEW_SECONDS
        or claims["nbf"] > now + _CLOCK_SKEW_SECONDS
        or claims["exp"] <= now
        or not isinstance(claims.get("jti"), str)
        or not _SAFE_ID.fullmatch(claims["jti"])
        or not isinstance(claims.get("nonce"), str)
        or not _SAFE_ID.fullmatch(claims["nonce"])
    ):
        raise _failure("voice_lab_d02_capability_binding_mismatch", 403)
    return hashlib.sha256(claims["jti"].encode("utf-8")).hexdigest()


def _database_url() -> str | None:
    value = (
        os.getenv("SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_URL") or ""
    ).strip()
    production = bool(
        (os.getenv("RENDER") or "").strip().lower() == "true"
        or (os.getenv("RENDER_SERVICE_ID") or "").strip()
        or (os.getenv("ENVIRONMENT") or "").strip().lower() == "production"
    )
    if production and not value:
        raise _failure("voice_lab_d02_gateway_database_unavailable", 503)
    return value or None


def _database_finalize_authority_config() -> tuple[str, bytes]:
    key_id = os.getenv(
        "SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_KEY_ID"
    ) or ""
    secret = os.getenv(
        "SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_SECRET"
    ) or ""
    try:
        secret_bytes = secret.encode("ascii")
    except UnicodeEncodeError as exc:
        raise _failure(
            "voice_lab_d02_finalize_authority_configuration_invalid", 503
        ) from exc
    if (
        re.fullmatch(r"[A-Za-z0-9._-]{1,64}", key_id) is None
        or not 32 <= len(secret_bytes) <= 256
        or any(ord(character) < 32 or ord(character) == 127 for character in secret)
    ):
        raise _failure(
            "voice_lab_d02_finalize_authority_configuration_invalid", 503
        )
    return key_id, secret_bytes


def _catalog_definition_sha256(value: str) -> str:
    return hashlib.sha256(" ".join(value.split()).encode("utf-8")).hexdigest()


def _assert_d02_gateway_catalog_ready(cursor: Any) -> None:
    table_names = tuple(_D02_COLUMNS)
    cursor.execute(
        """
        SELECT relation.relname, attribute.attname, type.typname,
               CASE WHEN attribute.attnotnull THEN 'NO' ELSE 'YES' END,
               CASE
                 WHEN type.typname IN ('bpchar', 'varchar')
                      AND attribute.atttypmod >= 4
                   THEN attribute.atttypmod - 4
                 ELSE NULL
               END,
               COALESCE(pg_get_expr(default_value.adbin,
                                    default_value.adrelid, true), ''),
               attribute.attgenerated, attribute.attidentity
          FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_attribute attribute
            ON attribute.attrelid = relation.oid
          JOIN pg_catalog.pg_type type ON type.oid = attribute.atttypid
          LEFT JOIN pg_catalog.pg_attrdef default_value
            ON default_value.adrelid = relation.oid
           AND default_value.adnum = attribute.attnum
         WHERE namespace.nspname = 'public'
           AND relation.relname = ANY(%s::text[])
           AND attribute.attnum > 0 AND NOT attribute.attisdropped
         ORDER BY relation.relname, attribute.attnum
        """,
        (list(table_names),),
    )
    columns: dict[str, list[tuple[Any, ...]]] = {name: [] for name in table_names}
    for table, *shape in cursor.fetchall():
        columns.setdefault(table, []).append(tuple(shape))
    if set(columns) != set(_D02_COLUMNS) or any(
        tuple(columns[table])
        != tuple((*column, "", "") for column in expected)
        for table, expected in _D02_COLUMNS.items()
    ):
        raise _failure("voice_lab_d02_gateway_database_catalog_invalid", 503)

    cursor.execute(
        """
        SELECT relation.relname, pg_get_userbyid(relation.relowner),
               relation.relkind, relation.relpersistence,
               relation.relispartition, relation.relrowsecurity,
               relation.relforcerowsecurity,
               NOT EXISTS (
                 SELECT 1 FROM pg_catalog.pg_inherits inheritance
                  WHERE inheritance.inhparent = relation.oid
                     OR inheritance.inhrelid = relation.oid
               ),
               NOT EXISTS (
                 SELECT 1 FROM pg_catalog.pg_rewrite rewrite
                  WHERE rewrite.ev_class = relation.oid
               ),
               NOT EXISTS (
                 SELECT 1 FROM pg_catalog.pg_attribute attribute
                  WHERE attribute.attrelid = relation.oid
                    AND attribute.attnum > 0
                    AND NOT attribute.attisdropped
                    AND attribute.attacl IS NOT NULL
               ),
               obj_description(relation.oid, 'pg_class')
          FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND starts_with(relation.relname, 'sophia_voice_lab_d02_')
           AND relation.relkind <> 'i'
         ORDER BY relation.relname
        """
    )
    relation_rows = cursor.fetchall()
    if len(relation_rows) != len(_D02_COLUMNS):
        raise _failure("voice_lab_d02_gateway_database_catalog_invalid", 503)
    for row in relation_rows:
        table = row[0]
        suffix = _D02_COMMENT_SUFFIXES.get(table)
        expected_comment = (
            "sophia.voice-lab."
            + suffix.format(hash=_D02_CLEANUP_MIGRATION_SHA256)
            if suffix is not None
            else None
        )
        if (
            table not in _D02_COLUMNS
            or row[1:10]
            != ("postgres", "r", "p", False, False, False, True, True, True)
            or row[10] != expected_comment
        ):
            raise _failure("voice_lab_d02_gateway_database_catalog_invalid", 503)

    cursor.execute(
        """
        SELECT relation.relname, grantee_role.rolname,
               acl.privilege_type, acl.is_grantable
          FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = relation.relnamespace
          CROSS JOIN LATERAL aclexplode(
            COALESCE(relation.relacl, acldefault('r', relation.relowner))
          ) acl
          LEFT JOIN pg_catalog.pg_roles grantee_role
            ON grantee_role.oid = acl.grantee
         WHERE namespace.nspname = 'public'
           AND relation.relname = ANY(%s::text[])
           AND acl.grantee <> relation.relowner
         ORDER BY relation.relname, grantee_role.rolname, acl.privilege_type
        """,
        (list(table_names),),
    )
    actual_acl = set(cursor.fetchall())
    expected_acl = {
        (table, "sophia_voice_lab_gateway", privilege, False)
        for table, privileges in _D02_GATEWAY_TABLE_PRIVILEGES.items()
        for privilege in privileges
    }
    if actual_acl != expected_acl:
        raise _failure("voice_lab_d02_gateway_database_catalog_invalid", 503)

    cursor.execute(
        """
        SELECT relation.relname, constraint_row.conname,
               constraint_row.contype, constraint_row.convalidated,
               constraint_row.condeferrable, constraint_row.condeferred,
               pg_get_constraintdef(constraint_row.oid, true)
          FROM pg_catalog.pg_constraint constraint_row
          JOIN pg_catalog.pg_class relation
            ON relation.oid = constraint_row.conrelid
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = ANY(%s::text[])
         ORDER BY relation.relname, constraint_row.conname
        """,
        (list(table_names),),
    )
    constraints = cursor.fetchall()
    if len(constraints) != len(_D02_CONSTRAINTS):
        raise _failure("voice_lab_d02_gateway_database_catalog_invalid", 503)
    for table, name, kind, validated, deferrable, deferred, definition in constraints:
        expected = _D02_CONSTRAINTS.get(f"{table}.{name}")
        if (
            expected is None
            or kind != expected[0]
            or validated is not True
            or deferrable is not False
            or deferred is not False
            or _catalog_definition_sha256(definition) != expected[1]
        ):
            raise _failure("voice_lab_d02_gateway_database_catalog_invalid", 503)

    cursor.execute(
        """
        SELECT table_relation.relname, index_relation.relname,
               index_row.indisunique, index_row.indisvalid,
               index_row.indisready, index_row.indimmediate,
               index_row.indnkeyatts,
               index_relation.relpersistence, access_method.amname,
               ARRAY(
                 SELECT pg_get_indexdef(index_row.indexrelid, position, true)
                   FROM generate_series(1, index_row.indnkeyatts) position
                  ORDER BY position
               ),
               ARRAY(
                 SELECT (index_row.indoption::smallint[])[position]
                   FROM generate_series(0, index_row.indnkeyatts - 1) position
                  ORDER BY position
               ),
               COALESCE(pg_get_expr(index_row.indpred,
                                    index_row.indrelid, true), ''),
               ARRAY(
                 SELECT operator_class.opcname
                   FROM unnest(index_row.indclass::oid[]) WITH ORDINALITY
                        item(oid, position)
                   JOIN pg_catalog.pg_opclass operator_class
                     ON operator_class.oid = item.oid
                  ORDER BY item.position
               ),
               ARRAY(
                 SELECT COALESCE(collation_row.collname, '')
                   FROM unnest(index_row.indcollation::oid[]) WITH ORDINALITY
                        item(oid, position)
                   LEFT JOIN pg_catalog.pg_collation collation_row
                     ON collation_row.oid = item.oid
                  ORDER BY item.position
               )
          FROM pg_catalog.pg_index index_row
          JOIN pg_catalog.pg_class index_relation
            ON index_relation.oid = index_row.indexrelid
          JOIN pg_catalog.pg_class table_relation
            ON table_relation.oid = index_row.indrelid
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = table_relation.relnamespace
          JOIN pg_catalog.pg_am access_method
            ON access_method.oid = index_relation.relam
         WHERE namespace.nspname = 'public'
           AND table_relation.relname = ANY(%s::text[])
         ORDER BY table_relation.relname, index_relation.relname
        """,
        (list(table_names),),
    )
    indexes = cursor.fetchall()
    if len(indexes) != len(_D02_INDEXES):
        raise _failure("voice_lab_d02_gateway_database_catalog_invalid", 503)
    for row in indexes:
        expected = _D02_INDEXES.get(row[1])
        actual = (
            row[0], row[2], int(row[6]), tuple(row[9]), tuple(row[10]),
            row[11], tuple(row[12]), tuple(row[13]),
        )
        if (
            expected is None
            or row[3:6] != (True, True, True)
            or row[7:9] != ("p", "btree")
            or actual != expected
        ):
            raise _failure("voice_lab_d02_gateway_database_catalog_invalid", 503)

    cursor.execute(
        """
        SELECT source.relname, constraint_row.conname,
               target.relname, procedure.proname,
               trigger_row.tgenabled, trigger_row.tgisinternal
          FROM pg_catalog.pg_trigger trigger_row
          JOIN pg_catalog.pg_constraint constraint_row
            ON constraint_row.oid = trigger_row.tgconstraint
          JOIN pg_catalog.pg_class source
            ON source.oid = constraint_row.conrelid
          JOIN pg_catalog.pg_class target
            ON target.oid = trigger_row.tgrelid
          JOIN pg_catalog.pg_proc procedure
            ON procedure.oid = trigger_row.tgfoid
         WHERE source.relname = ANY(%s::text[])
           AND constraint_row.contype = 'f'
         ORDER BY source.relname, constraint_row.conname,
                  target.relname, procedure.proname
        """,
        (list(table_names),),
    )
    foreign_key_triggers = cursor.fetchall()
    expected_foreign_keys = {
        key: value
        for key, value in _D02_CONSTRAINTS.items()
        if value[0] == "f"
    }
    if len(foreign_key_triggers) != len(expected_foreign_keys) * 4:
        raise _failure("voice_lab_d02_gateway_database_catalog_invalid", 503)
    for key in expected_foreign_keys:
        source, constraint_name = key.split(".", 1)
        rows = [
            row for row in foreign_key_triggers
            if row[0] == source and row[1] == constraint_name
        ]
        expected_shapes = {
            (source, "RI_FKey_check_ins"),
            (source, "RI_FKey_check_upd"),
            ("sophia_voice_lab_cleanup_obligations", "RI_FKey_cascade_del"),
            ("sophia_voice_lab_cleanup_obligations", "RI_FKey_noaction_upd"),
        }
        if (
            {(row[2], row[3]) for row in rows} != expected_shapes
            or any(row[4:] != ("O", True) for row in rows)
        ):
            raise _failure("voice_lab_d02_gateway_database_catalog_invalid", 503)

    cursor.execute(
        """
        SELECT relation.relname, trigger_row.tgname
          FROM pg_catalog.pg_trigger trigger_row
          JOIN pg_catalog.pg_class relation
            ON relation.oid = trigger_row.tgrelid
         WHERE relation.relname = ANY(%s::text[])
           AND NOT trigger_row.tgisinternal
        """,
        (list(table_names),),
    )
    if cursor.fetchall():
        raise _failure("voice_lab_d02_gateway_database_catalog_invalid", 503)

    cursor.execute(
        """
        SELECT procedure.proname,
               pg_get_function_identity_arguments(procedure.oid),
               pg_get_function_result(procedure.oid), language.lanname,
               procedure.provolatile, procedure.prosecdef,
               procedure.proisstrict, procedure.proparallel,
               procedure.prokind, procedure.proretset,
               procedure.proleakproof, procedure.pronargdefaults,
               procedure.proargmodes, procedure.proconfig,
               pg_get_userbyid(procedure.proowner),
               encode(pg_catalog.sha256(pg_catalog.convert_to(
                 procedure.prosrc, 'UTF8'
               )), 'hex'),
               obj_description(procedure.oid, 'pg_proc'),
               has_function_privilege(current_user, procedure.oid, 'EXECUTE')
          FROM pg_catalog.pg_proc procedure
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = procedure.pronamespace
          JOIN pg_catalog.pg_language language
            ON language.oid = procedure.prolang
         WHERE namespace.nspname = 'public'
           AND starts_with(procedure.proname, 'sophia_voice_lab_d02_')
         ORDER BY procedure.proname,
                  pg_get_function_identity_arguments(procedure.oid)
        """
    )
    function_rows = cursor.fetchall()
    if len(function_rows) != len(_D02_FUNCTIONS):
        raise _failure("voice_lab_d02_gateway_database_catalog_invalid", 503)
    for row in function_rows:
        expected = _D02_FUNCTIONS.get(row[0])
        if expected is None:
            raise _failure("voice_lab_d02_gateway_database_catalog_invalid", 503)
        expected_comment = (
            "sophia.voice-lab.d02-database-rpc.v1 migration_sha256="
            f"{_D02_CLEANUP_MIGRATION_SHA256} operation={expected[9]} "
            f"exposure={expected[10]}"
        )
        actual = (
            " ".join(str(row[1]).split()),
            " ".join(str(row[2]).split()),
            row[3], row[4], row[5], row[6], row[7], row[15], row[17],
        )
        expected_shape = (
            expected[0], expected[1], expected[2], expected[3], expected[4],
            expected[5], expected[6], expected[7], expected[8],
        )
        if (
            actual != expected_shape
            or row[8:12] != ("f", False, False, 0)
            or row[12] is not None
            or row[13] != ["search_path=pg_catalog, public, pg_temp"]
            or row[14] != "postgres"
            or row[16] != expected_comment
        ):
            raise _failure("voice_lab_d02_gateway_database_catalog_invalid", 503)

    cursor.execute(
        """
        SELECT procedure.proname, grantee_role.rolname,
               acl.privilege_type, acl.is_grantable
          FROM pg_catalog.pg_proc procedure
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = procedure.pronamespace
          CROSS JOIN LATERAL aclexplode(
            COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
          ) acl
          LEFT JOIN pg_catalog.pg_roles grantee_role
            ON grantee_role.oid = acl.grantee
         WHERE namespace.nspname = 'public'
           AND procedure.proname = ANY(%s::text[])
           AND acl.grantee <> procedure.proowner
         ORDER BY procedure.proname, grantee_role.rolname,
                  acl.privilege_type
        """,
        (list(_D02_FUNCTIONS),),
    )
    function_acl = set(cursor.fetchall())
    expected_function_acl = {
        (name, "sophia_voice_lab_gateway", "EXECUTE", False)
        for name, contract in _D02_FUNCTIONS.items()
        if contract[8]
    }
    expected_function_acl.add(
        (
            "sophia_voice_lab_d02_sources_zero",
            "better_auth_app",
            "EXECUTE",
            False,
        )
    )
    if function_acl != expected_function_acl:
        raise _failure("voice_lab_d02_gateway_database_catalog_invalid", 503)


def assert_d02_gateway_database_ready() -> None:
    """Attest the dedicated Gateway login and its exact least-privilege ACL."""

    dsn = _database_url()
    if dsn is None:
        return
    import psycopg

    expected: dict[str, frozenset[str]] = {
        "session": frozenset(),
        "sophia_sessions": frozenset(),
        "sophia_session_messages": frozenset(),
        "artifact_registry_records": frozenset(),
        "sophia_voice_lab_auth_grants": frozenset(),
        "sophia_voice_lab_cleanup_obligations": frozenset(),
        "sophia_voice_lab_cleanup_admissions": frozenset(),
        "sophia_voice_lab_cleanup_scan_cursors": frozenset(),
        **{table: frozenset() for table in _D02_COLUMNS},
    }
    all_privileges = (
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
        "MAINTAIN",
    )
    with psycopg.connect(dsn, connect_timeout=5) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT session_user, current_user,
                       role.rolcanlogin, role.rolsuper, role.rolinherit,
                       role.rolcreaterole,
                       role.rolcreatedb, role.rolreplication, role.rolbypassrls,
                       has_schema_privilege(current_user, 'public', 'CREATE'),
                       'supabase_pg17.directional_membership.v1',
                       (
                         SELECT count(*) <= 1
                            AND count(*) FILTER (
                              WHERE NOT (
                                membership.roleid = role.oid
                                AND member_role.rolname = 'postgres'
                                AND grantor_role.rolname = 'supabase_admin'
                                AND membership.admin_option = true
                                AND membership.inherit_option = false
                                AND membership.set_option = false
                              )
                            ) = 0
                           FROM pg_catalog.pg_auth_members membership
                           JOIN pg_catalog.pg_roles member_role
                             ON member_role.oid = membership.member
                           JOIN pg_catalog.pg_roles grantor_role
                             ON grantor_role.oid = membership.grantor
                          WHERE membership.member = role.oid
                             OR membership.roleid = role.oid
                       ),
                       (
                         SELECT count(*)
                           FROM pg_catalog.pg_auth_members membership
                           JOIN pg_catalog.pg_roles member_role
                             ON member_role.oid = membership.member
                           JOIN pg_catalog.pg_roles grantor_role
                             ON grantor_role.oid = membership.grantor
                          WHERE membership.roleid = role.oid
                            AND member_role.rolname = 'postgres'
                            AND grantor_role.rolname = 'supabase_admin'
                            AND membership.admin_option = true
                            AND membership.inherit_option = false
                            AND membership.set_option = false
                       ),
                       (
                         SELECT count(*)
                           FROM pg_catalog.pg_auth_members membership
                          WHERE membership.member = role.oid
                       ),
                       NOT EXISTS (
                         WITH RECURSIVE inherited_roles(role_oid) AS (
                           SELECT membership.roleid
                             FROM pg_catalog.pg_auth_members membership
                            WHERE membership.member = role.oid
                           UNION
                           SELECT membership.roleid
                             FROM pg_catalog.pg_auth_members membership
                             JOIN inherited_roles inherited
                               ON membership.member = inherited.role_oid
                         )
                         SELECT 1 FROM inherited_roles
                       ),
                       EXISTS (
                         SELECT 1
                           FROM pg_catalog.pg_default_acl defaults
                          WHERE defaults.defaclrole =
                                pg_catalog.to_regrole('postgres')
                            AND defaults.defaclnamespace = 0
                            AND defaults.defaclobjtype = 'f'
                            AND EXISTS (
                              SELECT 1
                                FROM pg_catalog.aclexplode(
                                  defaults.defaclacl
                                ) acl
                               WHERE acl.grantor =
                                     pg_catalog.to_regrole('postgres')
                                 AND acl.grantee =
                                     pg_catalog.to_regrole('postgres')
                                 AND acl.privilege_type = 'EXECUTE'
                                 AND acl.is_grantable = false
                            )
                            AND NOT EXISTS (
                              SELECT 1
                                FROM pg_catalog.aclexplode(
                                  defaults.defaclacl
                                ) acl
                               WHERE acl.grantee IN (
                                 0,
                                 pg_catalog.to_regrole(
                                   'sophia_voice_lab_gateway'
                                 )
                               )
                            )
                            AND NOT EXISTS (
                              SELECT 1
                                FROM pg_catalog.pg_default_acl additive
                                CROSS JOIN LATERAL pg_catalog.aclexplode(
                                  additive.defaclacl
                                ) additive_acl
                               WHERE additive.defaclrole = defaults.defaclrole
                                 AND additive.defaclobjtype = 'f'
                                 AND additive.defaclnamespace =
                                     pg_catalog.to_regnamespace('public')
                                 AND additive_acl.grantee IN (
                                   0,
                                   pg_catalog.to_regrole(
                                     'sophia_voice_lab_gateway'
                                   )
                                 )
                            )
                            AND NOT EXISTS (
                              SELECT 1
                                FROM pg_catalog.pg_default_acl future_defaults
                                CROSS JOIN LATERAL pg_catalog.aclexplode(
                                  future_defaults.defaclacl
                                ) future_acl
                               WHERE future_defaults.defaclrole =
                                     defaults.defaclrole
                                 AND future_defaults.defaclobjtype IN ('r', 'S')
                                 AND future_defaults.defaclnamespace IN (
                                   0,
                                   pg_catalog.to_regnamespace('public')
                                 )
                                 AND future_acl.grantee IN (
                                   0,
                                   pg_catalog.to_regrole(
                                     'sophia_voice_lab_gateway'
                                   )
                                 )
                            )
                       ),
                       pg_catalog.current_setting(
                         'session_replication_role'
                       ) = 'origin',
                       pg_catalog.current_setting(
                         'transaction_read_only'
                       ) = 'off',
                       pg_catalog.current_setting(
                         'synchronous_commit'
                       ) <> 'off',
                       NOT pg_catalog.pg_is_in_recovery()
                  FROM pg_catalog.pg_roles role
                 WHERE role.rolname = current_user
                """
            )
            row = cursor.fetchone()
            if row is None or len(row) != 20 or tuple(row[:10]) != (
                "sophia_voice_lab_gateway",
                "sophia_voice_lab_gateway",
                True,
                False,
                False,
                False,
                False,
                False,
                False,
                False,
            ):
                raise _failure("voice_lab_d02_gateway_database_role_invalid", 503)
            if (
                row[10] != "supabase_pg17.directional_membership.v1"
                or row[11] is not True
                or row[12] not in (0, 1)
                or row[13] != 0
                or row[14] is not True
                or row[15] is not True
            ):
                raise _failure("voice_lab_d02_gateway_database_role_invalid", 503)
            if tuple(row[16:]) != (True, True, True, True):
                raise _failure("voice_lab_d02_gateway_database_session_unsafe", 503)
            cursor.execute(
                """
                WITH application_schemas AS (
                  SELECT namespace.oid, namespace.nspname
                    FROM pg_catalog.pg_namespace namespace
                   WHERE namespace.nspname <> 'public'
                     AND namespace.nspname <> 'information_schema'
                     AND namespace.nspname !~ '^pg_'
                     AND (
                       NOT EXISTS (
                         SELECT 1
                           FROM pg_catalog.pg_extension extension_row
                          WHERE extension_row.extnamespace = namespace.oid
                       )
                       OR EXISTS (
                         SELECT 1
                           FROM pg_catalog.pg_class relation
                          WHERE relation.relnamespace = namespace.oid
                            AND relation.relkind IN (
                              'r', 'p', 'v', 'm', 'f', 'S'
                            )
                            AND NOT EXISTS (
                              SELECT 1
                                FROM pg_catalog.pg_depend dependency
                               WHERE dependency.classid =
                                     pg_catalog.to_regclass(
                                       'pg_catalog.pg_class'
                                     )
                                 AND dependency.objid = relation.oid
                                 AND dependency.deptype = 'e'
                            )
                       )
                       OR EXISTS (
                         SELECT 1
                           FROM pg_catalog.pg_proc procedure
                          WHERE procedure.pronamespace = namespace.oid
                            AND NOT EXISTS (
                              SELECT 1
                                FROM pg_catalog.pg_depend dependency
                               WHERE dependency.classid =
                                     pg_catalog.to_regclass(
                                       'pg_catalog.pg_proc'
                                     )
                                 AND dependency.objid = procedure.oid
                                 AND dependency.deptype = 'e'
                            )
                       )
                     )
                )
                SELECT schema_row.nspname
                  FROM application_schemas schema_row
                 WHERE pg_catalog.has_schema_privilege(
                         current_user, schema_row.oid, 'USAGE,CREATE'
                       )
                    OR EXISTS (
                      SELECT 1
                        FROM pg_catalog.pg_class relation
                       WHERE relation.relnamespace = schema_row.oid
                         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
                         AND (
                           pg_catalog.has_table_privilege(
                             current_user, relation.oid,
                             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
                           )
                           OR pg_catalog.has_any_column_privilege(
                             current_user, relation.oid,
                             'SELECT,INSERT,UPDATE,REFERENCES'
                           )
                         )
                    )
                    OR EXISTS (
                      SELECT 1
                        FROM pg_catalog.pg_class sequence_row
                       WHERE sequence_row.relnamespace = schema_row.oid
                         AND sequence_row.relkind = 'S'
                         AND pg_catalog.has_sequence_privilege(
                           current_user, sequence_row.oid,
                           'USAGE,SELECT,UPDATE'
                         )
                    )
                    OR EXISTS (
                      SELECT 1
                        FROM pg_catalog.pg_proc procedure
                       WHERE procedure.pronamespace = schema_row.oid
                         AND pg_catalog.has_function_privilege(
                           current_user, procedure.oid, 'EXECUTE'
                         )
                    )
                 LIMIT 1
                """
            )
            # PostgreSQL's has_* predicates include privileges inherited from
            # PUBLIC, so an apparently grant-free login still fails here when
            # an application schema or object is globally exposed.
            if cursor.fetchone() is not None:
                raise _failure("voice_lab_d02_gateway_database_acl_invalid", 503)
            for table_name, allowed in expected.items():
                cursor.execute(
                    """
                    SELECT privilege,
                           has_table_privilege(
                             current_user,
                             format('public.%%I', %s::text),
                             privilege
                           )
                      FROM unnest(%s::text[]) privilege
                     ORDER BY privilege
                    """,
                    (table_name, list(all_privileges)),
                )
                actual = {
                    privilege
                    for privilege, permitted in cursor.fetchall()
                    if permitted
                }
                if actual != allowed:
                    raise _failure(
                        "voice_lab_d02_gateway_database_acl_invalid", 503
                    )
            cursor.execute(
                """
                SELECT relation.relname
                  FROM pg_catalog.pg_class relation
                  JOIN pg_catalog.pg_namespace namespace
                    ON namespace.oid = relation.relnamespace
                 WHERE namespace.nspname = 'public'
                   AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
                   AND (
                     has_table_privilege(
                       current_user, relation.oid,
                       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
                     )
                     OR has_any_column_privilege(
                       current_user, relation.oid,
                       'SELECT,INSERT,UPDATE,REFERENCES'
                     )
                   )
                 LIMIT 1
                """
            )
            if cursor.fetchone() is not None:
                raise _failure("voice_lab_d02_gateway_database_acl_invalid", 503)
            cursor.execute(
                """
                SELECT relation.relname
                  FROM pg_catalog.pg_class relation
                  JOIN pg_catalog.pg_namespace namespace
                    ON namespace.oid = relation.relnamespace
                 WHERE namespace.nspname = 'public'
                   AND relation.relkind = 'S'
                   AND has_sequence_privilege(
                     current_user, relation.oid, 'USAGE,SELECT,UPDATE'
                   )
                 LIMIT 1
                """
            )
            if cursor.fetchone() is not None:
                raise _failure("voice_lab_d02_gateway_database_acl_invalid", 503)
            cursor.execute(
                """
                SELECT procedure.proname,
                       pg_get_function_identity_arguments(procedure.oid)
                  FROM pg_catalog.pg_proc procedure
                  JOIN pg_catalog.pg_namespace namespace
                    ON namespace.oid = procedure.pronamespace
                 WHERE namespace.nspname = 'public'
                   AND has_function_privilege(
                     current_user, procedure.oid, 'EXECUTE'
                   )
                 ORDER BY procedure.proname,
                          pg_get_function_identity_arguments(procedure.oid)
                """
            )
            actual_function_authority = {
                (name, " ".join(identity_arguments.split()))
                for name, identity_arguments in cursor.fetchall()
            }
            expected_function_authority = {
                (name, " ".join(contract[0].split()))
                for name, contract in _D02_FUNCTIONS.items()
                if contract[8]
            }
            if actual_function_authority != expected_function_authority:
                raise _failure("voice_lab_d02_gateway_database_acl_invalid", 503)
            _assert_d02_gateway_catalog_ready(cursor)
            authority_key_id, authority_secret = (
                _database_finalize_authority_config()
            )
            cursor.execute(
                """
                SELECT public.sophia_voice_lab_d02_finalize_authority_ready(
                  %s, %s
                )
                """,
                (
                    authority_key_id,
                    hashlib.sha256(authority_secret).hexdigest(),
                ),
            )
            if cursor.fetchone() != (True,):
                raise _failure(
                    "voice_lab_d02_finalize_authority_configuration_invalid",
                    503,
                )


def _register_capability_use(
    cursor: Any,
    *,
    capability_jti_sha256: str,
    operation: str,
    request_sha256: str,
    cleanup_obligation_id: str,
    termination_request_id_sha256: str,
) -> None:
    if cursor is not None:
        raise RuntimeError("D02 database capability use must be prepared by RPC")
    binding = (
        operation,
        request_sha256,
        cleanup_obligation_id,
        termination_request_id_sha256,
    )
    existing = _LOCAL_CAPABILITY_USES.get(capability_jti_sha256)
    if existing is not None and existing != binding:
        raise _failure("voice_lab_d02_capability_replay_conflict", 409)
    _LOCAL_CAPABILITY_USES[capability_jti_sha256] = binding


def _json_object(value: object) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        return dict(parsed) if isinstance(parsed, dict) else None
    return None


def _synthetic_from_metadata(metadata: object) -> tuple[dict[str, Any], dict[str, Any]]:
    mapped = _json_object(metadata)
    synthetic = _json_object(mapped.get("synthetic_voice_lab")) if mapped else None
    if mapped is None or synthetic is None:
        raise _failure("voice_lab_d02_session_binding_unavailable", 409)
    return mapped, synthetic


def _expected_live_epochs(synthetic: dict[str, Any]) -> tuple[int, ...]:
    epochs = {
        value
        for value in (
            synthetic.get("voice_provider_connection_epoch"),
            synthetic.get("voice_provider_pending_connection_epoch"),
        )
        if isinstance(value, int) and not isinstance(value, bool) and value > 0
    }
    if not epochs:
        raise _failure("voice_lab_d02_provider_epoch_authority_unavailable", 409)
    return tuple(sorted(epochs))


def _session_binding_matches(
    *,
    synthetic: dict[str, Any],
    metadata: dict[str, Any],
    body: D02FreezeRequest | D02SettlementRequest,
    user_id: object,
    run_id: object,
) -> bool:
    expected_deployment = metadata.get("expected_deployment")
    voice_public_key = synthetic.get(
        "voice_runtime_instance_public_key_spki_base64"
    )
    try:
        voice_public_bytes = (
            base64.b64decode(voice_public_key, validate=True)
            if isinstance(voice_public_key, str)
            else b""
        )
        voice_public_valid = (
            bool(voice_public_bytes)
            and base64.b64encode(voice_public_bytes).decode("ascii")
            == voice_public_key
            and isinstance(
                serialization.load_der_public_key(voice_public_bytes),
                Ed25519PublicKey,
            )
            and synthetic.get("voice_runtime_instance_id_sha256")
            == hashlib.sha256(voice_public_bytes).hexdigest()
        )
    except (TypeError, ValueError):
        voice_public_valid = False
    return bool(
        synthetic.get("synthetic") is True
        and synthetic.get("scenario_id") == "V-D02"
        and synthetic.get("test_run_id") == body.test_run_id
        and run_id == body.test_run_id
        and user_id == synthetic.get("principal_id")
        and synthetic.get("cleanup_obligation_id") == body.cleanup_obligation_id
        and synthetic.get("voice_runtime_session_id") == body.provider_session_id
        and synthetic.get("voice_lab_run_id_sha256") == body.voice_lab_run_id_sha256
        and synthetic.get("browser_worker_id_sha256")
        == body.browser_worker_id_sha256
        and synthetic.get("browser_lease_epoch") == body.browser_lease_epoch
        and synthetic.get("browser_context_id_sha256")
        == body.browser_context_id_sha256
        and voice_public_valid
        and isinstance(expected_deployment, dict)
        and set(expected_deployment) == {"frontend", "backend", "voice"}
        and synthetic.get("voice_runtime_owner_deployment_sha")
        == expected_deployment.get("voice")
        and all(
            isinstance(expected_deployment.get(component), str)
            and _SHA1.fullmatch(expected_deployment[component])
            for component in ("frontend", "backend", "voice")
        )
    )


def _freeze_projection(body: D02FreezeRequest) -> dict[str, Any]:
    return _request_dict(body)


def _settlement_freeze_projection(body: D02SettlementRequest) -> dict[str, Any]:
    return {
        "schema": D02_FREEZE_SCHEMA,
        "termination_request_id": body.termination_request_id,
        "voice_lab_run_id_sha256": body.voice_lab_run_id_sha256,
        "test_run_id": body.test_run_id,
        "cleanup_obligation_id": body.cleanup_obligation_id,
        "provider_session_id": body.provider_session_id,
        "provider_admission_id_sha256": body.provider_admission_id_sha256,
        "provider_connection_epoch": body.provider_connection_epoch,
        "frozen_provider_connection_epochs": list(
            body.frozen_provider_connection_epochs
        ),
        "browser_worker_id_sha256": body.browser_worker_id_sha256,
        "browser_lease_epoch": body.browser_lease_epoch,
        "browser_context_id_sha256": body.browser_context_id_sha256,
        "render_action_request_sha256": body.render_action_request_sha256,
    }


def _stored_freeze_projection(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if key != "requested_at"}


def _validated_terminal_receipt(
    receipt_value: object,
    synthetic: dict[str, Any],
    frozen_epochs: tuple[int, ...],
) -> dict[str, Any]:
    receipt = _json_object(receipt_value)
    if not isinstance(receipt, dict):
        raise _failure("voice_lab_d02_voice_terminal_receipt_required", 409)
    required = {
        "schema",
        "issuer",
        "audience",
        "authority_key_id",
        "cleanup_obligation_id",
        "provider_admission_id",
        "provider_session_id",
        "provider_connection_epochs",
        "voice_runtime_instance_id_sha256",
        "voice_provider_session_absent",
        "voice_relay_state_absent",
        "observed_at",
        "jti",
        "signature_algorithm",
        "receipt_sha256",
        "signature",
    }
    core = {
        key: value
        for key, value in receipt.items()
        if key not in {"receipt_sha256", "signature"}
    }
    receipt_sha256 = _canonical_hash(core)
    receipt_epochs = receipt.get("provider_connection_epochs")
    public_raw = synthetic.get("voice_runtime_instance_public_key_spki_base64")
    try:
        public_bytes = (
            base64.b64decode(public_raw, validate=True)
            if isinstance(public_raw, str)
            else b""
        )
        if (
            not public_bytes
            or base64.b64encode(public_bytes).decode("ascii") != public_raw
        ):
            raise ValueError("noncanonical Voice runtime key")
        public_key = serialization.load_der_public_key(public_bytes)
        if not isinstance(public_key, Ed25519PublicKey):
            raise ValueError("wrong Voice runtime key type")
    except (TypeError, ValueError) as exc:
        raise _failure("voice_lab_d02_voice_terminal_authority_invalid", 409) from exc
    instance_sha256 = hashlib.sha256(public_bytes).hexdigest()
    expected_key_id = f"voice-runtime-{instance_sha256[:16]}"
    supplied_signature = receipt.get("signature")
    try:
        supplied_signature_bytes = (
            _b64url_decode(supplied_signature)
            if isinstance(supplied_signature, str)
            else b""
        )
        public_key.verify(
            supplied_signature_bytes,
            bytes.fromhex(receipt_sha256),
        )
    except HTTPException as exc:
        raise _failure("voice_lab_d02_voice_terminal_receipt_invalid", 409) from exc
    except Exception as exc:  # noqa: BLE001 - exact source proof is fail closed.
        if isinstance(exc, HTTPException):
            raise
        raise _failure("voice_lab_d02_voice_terminal_receipt_invalid", 409) from exc
    if (
        set(receipt) != required
        or receipt.get("schema") != D02_VOICE_TERMINAL_SCHEMA
        or receipt.get("issuer") != D02_VOICE_TERMINAL_ISSUER
        or receipt.get("audience") != D02_VOICE_TERMINAL_AUDIENCE
        or receipt.get("authority_key_id") != expected_key_id
        or not isinstance(receipt_epochs, list)
        or any(type(epoch) is not int or epoch <= 0 for epoch in receipt_epochs)
        or tuple(receipt_epochs) != frozen_epochs
        or receipt.get("voice_runtime_instance_id_sha256") != instance_sha256
        or receipt.get("voice_provider_session_absent") is not True
        or receipt.get("voice_relay_state_absent") is not True
        or _parse_canonical_utc_millis(receipt.get("observed_at")) is None
        or _uuid4(receipt.get("jti")) is None
        or receipt.get("signature_algorithm")
        != "ed25519-sha256-canonical-json-v1"
        or receipt.get("receipt_sha256") != receipt_sha256
    ):
        raise _failure("voice_lab_d02_voice_terminal_receipt_invalid", 409)
    return dict(receipt)


def _canonical_browser_terminal_settlement(
    synthetic: dict[str, Any],
    provider_session_id: str,
) -> tuple[set[int], str]:
    from app.gateway.routers import voice as voice_module

    close = synthetic.get("voice_provider_browser_close_receipts")
    abort = synthetic.get("voice_provider_activation_abort_receipts")
    if not isinstance(close, list) or not isinstance(abort, list):
        raise _failure("voice_lab_d02_browser_terminal_receipts_required", 409)
    try:
        close_models = [
            voice_module.GeminiBrowserProviderCloseReceipt.model_validate(item)
            for item in close
        ]
        abort_models = [
            voice_module.GeminiBrowserProviderActivationAbortReceipt.model_validate(
                item
            )
            for item in abort
        ]
        canonical_close, canonical_abort, settlement_sha256 = (
            voice_module._canonical_browser_provider_settlement(
                provider_session_id,
                close_models,
                abort_models,
            )
        )
    except (HTTPException, TypeError, ValueError) as exc:
        raise _failure("voice_lab_d02_browser_terminal_receipts_invalid", 409) from exc
    if (
        _canonical_json(canonical_close) != _canonical_json(close)
        or _canonical_json(canonical_abort) != _canonical_json(abort)
    ):
        raise _failure("voice_lab_d02_browser_terminal_receipts_invalid", 409)
    close_epochs = {
        int(receipt["provider_connection_epoch"]) for receipt in canonical_close
    }
    abort_epochs = {int(receipt["candidate_epoch"]) for receipt in canonical_abort}
    return close_epochs.union(abort_epochs), settlement_sha256


def _identity_hmac(principal_id: str) -> str:
    secret = _required_secret(
        "SOPHIA_VOICE_LAB_D02_SETTLEMENT_IDENTITY_HMAC_SECRET"
    )
    return hmac.new(
        secret.encode("utf-8"),
        b"sophia-voice-lab-d02-principal-v1\0" + principal_id.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _receipt_private_key() -> tuple[Ed25519PrivateKey, str]:
    raw = (
        os.getenv("SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PRIVATE_KEY_PKCS8_BASE64")
        or ""
    ).strip()
    key_id = (
        os.getenv("SOPHIA_VOICE_LAB_D02_SETTLEMENT_AUTHORITY_KEY_ID") or ""
    ).strip()
    public_raw = (
        os.getenv("SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEY_SPKI_BASE64")
        or ""
    ).strip()
    if not _SAFE_ID.fullmatch(key_id) or not raw or not public_raw:
        raise _failure("voice_lab_d02_signing_configuration_invalid", 503)
    try:
        private_bytes = base64.b64decode(raw, validate=True)
        public_bytes = base64.b64decode(public_raw, validate=True)
        if base64.b64encode(private_bytes).decode("ascii") != raw:
            raise ValueError("noncanonical private key")
        if base64.b64encode(public_bytes).decode("ascii") != public_raw:
            raise ValueError("noncanonical public key")
        key = serialization.load_der_private_key(private_bytes, password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise ValueError("wrong private key type")
        actual = key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        if not hmac.compare_digest(actual, public_bytes):
            raise ValueError("public key mismatch")
    except (TypeError, ValueError) as exc:
        raise _failure("voice_lab_d02_signing_configuration_invalid", 503) from exc
    return key, key_id


def _receipt_public_keyring() -> dict[str, Ed25519PublicKey]:
    """Load the bounded canonical verification set retained through purge.

    The current public key must be an exact member.  Historical keys remain
    verification-only so an immutable stored receipt can be replayed after a
    signing-key rotation without re-signing or extending its issuance TTL.
    """

    encoded = (
        os.getenv(
            "SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEYRING_JSON"
        )
        or ""
    ).strip()
    current_id = (
        os.getenv("SOPHIA_VOICE_LAB_D02_SETTLEMENT_AUTHORITY_KEY_ID") or ""
    ).strip()
    current_public = (
        os.getenv(
            "SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEY_SPKI_BASE64"
        )
        or ""
    ).strip()
    try:
        raw_keyring = json.loads(encoded)
        if (
            not isinstance(raw_keyring, dict)
            or not 1 <= len(raw_keyring) <= 8
            or not _SAFE_ID.fullmatch(current_id)
            or raw_keyring.get(current_id) != current_public
        ):
            raise ValueError("invalid current D02 keyring binding")
        parsed: dict[str, Ed25519PublicKey] = {}
        fingerprints: set[str] = set()
        for key_id, public_raw in raw_keyring.items():
            if (
                not isinstance(key_id, str)
                or not _SAFE_ID.fullmatch(key_id)
                or not isinstance(public_raw, str)
            ):
                raise ValueError("invalid D02 keyring entry")
            public_bytes = base64.b64decode(public_raw, validate=True)
            if base64.b64encode(public_bytes).decode("ascii") != public_raw:
                raise ValueError("noncanonical D02 public key")
            public_key = serialization.load_der_public_key(public_bytes)
            if not isinstance(public_key, Ed25519PublicKey):
                raise ValueError("D02 public key is not Ed25519")
            canonical = public_key.public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            if not hmac.compare_digest(canonical, public_bytes):
                raise ValueError("noncanonical D02 SPKI")
            fingerprint = hashlib.sha256(canonical).hexdigest()
            if fingerprint in fingerprints:
                raise ValueError("duplicate D02 public key")
            fingerprints.add(fingerprint)
            parsed[key_id] = public_key
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise _failure("voice_lab_d02_signing_configuration_invalid", 503) from exc
    return parsed


def _sign_receipt(unsigned: dict[str, Any]) -> dict[str, Any]:
    key, _ = _receipt_private_key()
    _receipt_public_keyring()
    signature = key.sign(bytes.fromhex(_canonical_hash(unsigned)))
    return {
        **unsigned,
        "signature": base64.urlsafe_b64encode(signature)
        .rstrip(b"=")
        .decode("ascii"),
    }


def _verify_stored_receipt(receipt: object) -> dict[str, Any]:
    mapped = _json_object(receipt)
    if mapped is None or not isinstance(mapped.get("signature"), str):
        raise _failure("voice_lab_d02_stored_receipt_invalid", 503)
    unsigned = dict(mapped)
    signature_raw = unsigned.pop("signature")
    try:
        signature = _b64url_decode(signature_raw)
        key_id = unsigned.get("authority_key_id")
        keyring = _receipt_public_keyring()
        if not isinstance(key_id, str):
            raise ValueError("invalid D02 settlement public keyring")
        public_key = keyring.get(key_id)
        if public_key is None:
            raise ValueError("D02 settlement verification key is unavailable")
        public_key.verify(signature, bytes.fromhex(_canonical_hash(unsigned)))
    except Exception as exc:  # noqa: BLE001 - any crypto drift is fail closed.
        if isinstance(exc, HTTPException):
            raise
        raise _failure("voice_lab_d02_stored_receipt_invalid", 503) from exc
    return mapped


def _build_receipt(
    *,
    body: D02SettlementRequest,
    metadata: dict[str, Any],
    synthetic: dict[str, Any],
    obligation_state: str,
    provider_settlement_sha256: str,
    voice_terminal_receipt: dict[str, Any],
    database_now: datetime,
) -> dict[str, Any]:
    principal_id = synthetic.get("principal_id")
    scenario_version = synthetic.get("scenario_version")
    environment = synthetic.get("environment")
    expected_deployment = metadata.get("expected_deployment")
    if (
        not isinstance(principal_id, str)
        or not _SAFE_ID.fullmatch(principal_id)
        or not isinstance(scenario_version, str)
        or not _SAFE_ID.fullmatch(scenario_version)
        or environment not in {"production", "staging"}
        or not isinstance(expected_deployment, dict)
    ):
        raise _failure("voice_lab_d02_session_binding_invalid", 409)
    issued_at = _canonical_utc_millis(database_now)
    receipt_id = str(uuid.uuid4())
    unsigned = {
        "schema": D02_SETTLEMENT_SCHEMA,
        "receipt_id": receipt_id,
        "termination_request_id_sha256": hashlib.sha256(
            body.termination_request_id.encode("utf-8")
        ).hexdigest(),
        "voice_lab_run_id_sha256": body.voice_lab_run_id_sha256,
        "test_run_id_sha256": hashlib.sha256(
            body.test_run_id.encode("utf-8")
        ).hexdigest(),
        "cleanup_obligation_id_sha256": hashlib.sha256(
            body.cleanup_obligation_id.encode("utf-8")
        ).hexdigest(),
        "principal_id_hmac": _identity_hmac(principal_id),
        "scenario_id": "V-D02",
        "scenario_version": scenario_version,
        "environment": environment,
        "expected_deployment": expected_deployment,
        "provider_session_id_sha256": hashlib.sha256(
            body.provider_session_id.encode("utf-8")
        ).hexdigest(),
        "provider_admission_id_sha256": body.provider_admission_id_sha256,
        "provider_connection_epoch": body.provider_connection_epoch,
        "frozen_provider_connection_epochs": list(
            body.frozen_provider_connection_epochs
        ),
        "browser_worker_id_sha256": body.browser_worker_id_sha256,
        "browser_lease_epoch": body.browser_lease_epoch,
        "browser_context_id_sha256": body.browser_context_id_sha256,
        "render_action_request_sha256": body.render_action_request_sha256,
        "render_action_accepted_response_sha256": body.render_action_accepted_response_sha256,
        "render_action_settled_snapshot_sha256": body.render_action_settled_snapshot_sha256,
        "loss_event_seq": body.loss_event_seq,
        "loss_observed_at": body.loss_observed_at,
        "voice_terminal_receipts_sha256": _canonical_hash(
            [voice_terminal_receipt]
        ),
        "provider_settlement_sha256": provider_settlement_sha256,
        "cleanup_obligation_state": obligation_state,
        "canonical_provider_state": "closed",
        "canonical_pending_epoch": None,
        "all_frozen_provider_epochs_terminal": True,
        "provider_admission_absent": True,
        "voice_provider_session_absent": True,
        "gateway_browser_relay_absent": True,
        "database_observed_at": issued_at,
        "issuer": D02_RECEIPT_ISSUER,
        "audience": D02_RECEIPT_AUDIENCE,
        "authority_key_id": _receipt_private_key()[1],
        "jti": receipt_id,
        "nonce": secrets.token_urlsafe(32),
        "issued_at": issued_at,
        "expires_at": _canonical_utc_millis(database_now + _RECEIPT_TTL),
        "signature_algorithm": "ed25519-sha256-canonical-request-v1",
    }
    return _sign_receipt(unsigned)


def _continuity_projection(
    *,
    session_id: object,
    thread_id: object,
    user_id: object,
    run_id: object,
    status: object,
    message_revision: object,
    metadata_value: object,
    admission_id: object,
    admission_status: object,
    admission_resource_id: object,
    cleanup_obligation_id: str,
) -> dict[str, Any]:
    metadata, synthetic = _synthetic_from_metadata(metadata_value)
    expected_deployment = metadata.get("expected_deployment")
    current_epoch = synthetic.get("voice_provider_connection_epoch")
    pending_epoch = synthetic.get("voice_provider_pending_connection_epoch")
    principal_id = synthetic.get("principal_id")
    test_run_id = synthetic.get("test_run_id")
    provider_session_id = synthetic.get("voice_runtime_session_id")
    if (
        not isinstance(session_id, str)
        or not session_id
        or not isinstance(thread_id, str)
        or not thread_id
        or not isinstance(user_id, str)
        or not isinstance(run_id, str)
        or status not in {"active", "open", "paused", "resumable"}
        or not isinstance(message_revision, int)
        or isinstance(message_revision, bool)
        or message_revision < 0
        or synthetic.get("synthetic") is not True
        or synthetic.get("scenario_id") != "V-D02"
        or synthetic.get("cleanup_obligation_id") != cleanup_obligation_id
        or not isinstance(test_run_id, str)
        or _uuid4(test_run_id) is None
        or run_id != test_run_id
        or not isinstance(principal_id, str)
        or user_id != principal_id
        or not isinstance(provider_session_id, str)
        or not _SAFE_ID.fullmatch(provider_session_id)
        or admission_resource_id != provider_session_id
        or not isinstance(admission_id, str)
        or _uuid4(admission_id) is None
        or admission_status != "browser_active"
        or synthetic.get("voice_provider_resource_state") != "active"
        or not isinstance(current_epoch, int)
        or isinstance(current_epoch, bool)
        or current_epoch <= 0
        or (
            pending_epoch is not None
            and (
                not isinstance(pending_epoch, int)
                or isinstance(pending_epoch, bool)
                or pending_epoch != current_epoch + 1
            )
        )
        or not isinstance(expected_deployment, dict)
        or set(expected_deployment) != {"frontend", "backend", "voice"}
        or any(
            not isinstance(expected_deployment.get(component), str)
            or not _SHA1.fullmatch(expected_deployment[component])
            for component in ("frontend", "backend", "voice")
        )
        or synthetic.get("voice_runtime_owner_deployment_sha")
        != expected_deployment["voice"]
        or not isinstance(synthetic.get("voice_lab_run_id_sha256"), str)
        or not _SHA256.fullmatch(synthetic["voice_lab_run_id_sha256"])
        or not isinstance(synthetic.get("browser_worker_id_sha256"), str)
        or not _SHA256.fullmatch(synthetic["browser_worker_id_sha256"])
        or not isinstance(synthetic.get("browser_lease_epoch"), int)
        or isinstance(synthetic.get("browser_lease_epoch"), bool)
        or synthetic["browser_lease_epoch"] <= 0
        or not isinstance(synthetic.get("browser_context_id_sha256"), str)
        or not _SHA256.fullmatch(synthetic["browser_context_id_sha256"])
        or not isinstance(
            synthetic.get("voice_runtime_instance_id_sha256"), str
        )
        or not _SHA256.fullmatch(
            synthetic["voice_runtime_instance_id_sha256"]
        )
    ):
        raise _failure("voice_lab_d02_continuity_binding_invalid", 409)
    return {
        "session_id_sha256": hashlib.sha256(session_id.encode()).hexdigest(),
        "thread_id_sha256": hashlib.sha256(thread_id.encode()).hexdigest(),
        "principal_id_hmac": _identity_hmac(principal_id),
        "test_run_id_sha256": hashlib.sha256(test_run_id.encode()).hexdigest(),
        "cleanup_obligation_id_sha256": hashlib.sha256(
            cleanup_obligation_id.encode()
        ).hexdigest(),
        "provider_session_id_sha256": hashlib.sha256(
            provider_session_id.encode()
        ).hexdigest(),
        "provider_admission_id_sha256": hashlib.sha256(
            admission_id.encode()
        ).hexdigest(),
        "voice_lab_run_id_sha256": synthetic["voice_lab_run_id_sha256"],
        "browser_worker_id_sha256": synthetic["browser_worker_id_sha256"],
        "browser_lease_epoch": synthetic["browser_lease_epoch"],
        "browser_context_id_sha256": synthetic["browser_context_id_sha256"],
        "voice_runtime_instance_id_sha256": synthetic[
            "voice_runtime_instance_id_sha256"
        ],
        "expected_deployment": dict(expected_deployment),
        "session_status": status,
        "message_revision": message_revision,
        "canonical_provider_state": "active",
        "provider_connection_epoch": current_epoch,
        "provider_pending_connection_epoch": pending_epoch,
    }


def _build_continuity_receipt(
    *,
    body: D02ContinuityObservationRequest,
    request_sha256: str,
    projection: dict[str, Any],
    database_now: datetime,
) -> dict[str, Any]:
    issued_at = _canonical_utc_millis(database_now)
    key_id = _receipt_private_key()[1]
    receipt_id = str(uuid.uuid4())
    core: dict[str, Any] = {
        "schema": D02_CONTINUITY_SCHEMA,
        "receipt_id": receipt_id,
        "restart_request_id_sha256": hashlib.sha256(
            body.restart_request_id.encode()
        ).hexdigest(),
        "phase": body.phase,
        "request_sha256": request_sha256,
        "product_service_boot_id_sha256": body.product_service_boot_id_sha256,
        "render_action_request_sha256": body.render_action_request_sha256,
        "prior_observation_receipt_sha256": (
            body.prior_observation_receipt_sha256
        ),
        "continuity_projection": projection,
        "cleanup_obligation_state": "open",
        "cleanup_lifecycle_phase": "session_provisional",
        "d02_freeze_absent": True,
        "database_observed_at": issued_at,
        "issuer": D02_RECEIPT_ISSUER,
        "audience": "sophia-voice-lab-d02-product-continuity",
        "authority_key_id": key_id,
        "jti": receipt_id,
        "nonce": secrets.token_urlsafe(32),
        "issued_at": issued_at,
        "expires_at": _canonical_utc_millis(database_now + _RECEIPT_TTL),
        "signature_algorithm": "ed25519-sha256-canonical-request-v1",
    }
    receipt_sha256 = _canonical_hash(core)
    return _sign_receipt({**core, "receipt_sha256": receipt_sha256})


def _database_finalize_proof(
    *,
    domain: str,
    parts: tuple[str, ...],
    value: object,
) -> tuple[str, str]:
    """Bind one execute-only D02 mutation to its exact Python-validated value."""

    key_id, secret_bytes = _database_finalize_authority_config()
    try:
        for part in parts:
            part.encode("ascii")
        canonical_value_unicode = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        canonical_value_unicode.encode("ascii")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise _failure(
            "voice_lab_d02_finalize_authority_configuration_invalid", 503
        ) from exc
    if (
        not 1 <= len(parts) <= 32
        or any(not 1 <= len(part) <= 512 for part in parts)
    ):
        raise _failure(
            "voice_lab_d02_finalize_authority_configuration_invalid", 503
        )
    canonical_value = _canonical_json(value)
    if len(canonical_value.encode("ascii")) > 262_144:
        raise _failure(
            "voice_lab_d02_finalize_authority_configuration_invalid", 503
        )
    value_sha256 = hashlib.sha256(canonical_value.encode("ascii")).hexdigest()
    core = {
        "authority_key_id": key_id,
        "domain": domain,
        "parts": list(parts),
        "value_sha256": value_sha256,
    }
    proof = hmac.new(
        secret_bytes,
        _canonical_json(core).encode("ascii"),
        hashlib.sha256,
    ).hexdigest()
    return key_id, proof


def _d02_rpc_json(cursor: Any, statement: str, parameters: tuple[object, ...]) -> dict[str, Any]:
    cursor.execute(statement, parameters)
    row = cursor.fetchone()
    value = _json_object(row[0]) if isinstance(row, tuple) and len(row) == 1 else None
    if value is None or not isinstance(value.get("status"), str):
        raise _failure("voice_lab_d02_gateway_database_response_invalid", 503)
    return value


def _d02_rpc_boolean(
    cursor: Any,
    statement: str,
    parameters: tuple[object, ...],
) -> bool:
    cursor.execute(statement, parameters)
    row = cursor.fetchone()
    if row not in {(True,), (False,)}:
        raise _failure("voice_lab_d02_gateway_database_response_invalid", 503)
    return bool(row[0])


def _database_observed_at(value: object) -> datetime:
    parsed = _parse_canonical_utc_millis(value)
    if parsed is None:
        raise _failure("voice_lab_d02_gateway_database_response_invalid", 503)
    return parsed


def _raise_finalize_authority_invalid() -> None:
    raise _failure("voice_lab_d02_gateway_database_authority_invalid", 503)


def _freeze_database(
    body: D02FreezeRequest,
    *,
    request_sha256: str,
    capability_jti_sha256: str,
) -> dict[str, Any]:
    dsn = _database_url()
    if dsn is None:
        return _freeze_local(
            body,
            request_sha256=request_sha256,
            capability_jti_sha256=capability_jti_sha256,
        )
    import psycopg

    termination_hash = hashlib.sha256(
        body.termination_request_id.encode("utf-8")
    ).hexdigest()
    freeze_binding = _freeze_projection(body)
    with psycopg.connect(dsn, connect_timeout=5) as connection:
        with connection.cursor() as cursor:
            authorized = _d02_rpc_json(
                cursor,
                """
                SELECT public.sophia_voice_lab_d02_freeze_authorize(
                  %s::text, %s::text, %s::text, %s::text
                )
                """,
                (
                    body.cleanup_obligation_id,
                    termination_hash,
                    request_sha256,
                    capability_jti_sha256,
                ),
            )
            status = authorized["status"]
            if status == "capability_replay_conflict":
                raise _failure("voice_lab_d02_capability_replay_conflict", 409)
            if status == "existing":
                stored = _json_object(authorized.get("freeze_binding"))
                if (
                    authorized.get("freeze_request_sha256") == request_sha256
                    and stored == freeze_binding
                ):
                    return {
                        "frozen": True,
                        "idempotent_replay": True,
                        "freeze_request_sha256": request_sha256,
                    }
                raise _failure("voice_lab_d02_freeze_conflict", 409)
            if status in {"binding_unavailable", "binding_cardinality_invalid"}:
                raise _failure("voice_lab_d02_freeze_binding_unavailable", 409)
            if status != "candidate":
                raise _failure(
                    "voice_lab_d02_gateway_database_response_invalid", 503
                )
            metadata, synthetic = _synthetic_from_metadata(
                authorized.get("metadata")
            )
            admission_id = authorized.get("admission_id")
            if (
                not isinstance(admission_id, str)
                or _uuid4(admission_id) != admission_id
                or not _session_binding_matches(
                    synthetic=synthetic,
                    metadata=metadata,
                    body=body,
                    user_id=authorized.get("user_id"),
                    run_id=authorized.get("run_id"),
                )
                or authorized.get("obligation_state") != "open"
                or authorized.get("lifecycle_phase") != "session_provisional"
                or authorized.get("live_cleanup_completed_at") is not None
                or authorized.get("admission_status")
                not in {"credential_minted", "browser_active"}
                or authorized.get("admission_resource_id")
                != body.provider_session_id
                or hashlib.sha256(admission_id.encode("utf-8")).hexdigest()
                != body.provider_admission_id_sha256
                or _expected_live_epochs(synthetic)
                != body.frozen_provider_connection_epochs
                or synthetic.get("voice_provider_connection_epoch")
                != body.provider_connection_epoch
            ):
                raise _failure("voice_lab_d02_freeze_binding_mismatch", 409)
            authority_key_id, proof = _database_finalize_proof(
                domain="freeze_finalize_v1",
                parts=(
                    body.cleanup_obligation_id,
                    termination_hash,
                    body.provider_session_id,
                    admission_id,
                    request_sha256,
                    capability_jti_sha256,
                ),
                value=freeze_binding,
            )
            finalized = _d02_rpc_json(
                cursor,
                """
                SELECT public.sophia_voice_lab_d02_freeze_finalize(
                  %s::text, %s::text, %s::text, %s::uuid, %s::text,
                  %s::text, %s::jsonb, %s::text, %s::text
                )
                """,
                (
                    body.cleanup_obligation_id,
                    termination_hash,
                    body.provider_session_id,
                    admission_id,
                    request_sha256,
                    capability_jti_sha256,
                    _canonical_json(freeze_binding),
                    authority_key_id,
                    proof,
                ),
            )
            finalize_status = finalized["status"]
            if finalize_status in {"created", "replay"}:
                return {
                    "frozen": True,
                    "idempotent_replay": finalize_status == "replay",
                    "freeze_request_sha256": request_sha256,
                }
            if finalize_status == "freeze_conflict":
                raise _failure("voice_lab_d02_freeze_conflict", 409)
            if finalize_status in {
                "finalize_proof_invalid",
                "capability_prepare_required",
            }:
                _raise_finalize_authority_invalid()
            if finalize_status in {
                "binding_unavailable",
                "binding_cardinality_invalid",
            }:
                raise _failure("voice_lab_d02_freeze_binding_unavailable", 409)
            if finalize_status == "binding_mismatch":
                raise _failure("voice_lab_d02_freeze_binding_mismatch", 409)
            if finalize_status == "fence_conflict":
                raise _failure("voice_lab_d02_freeze_fence_conflict", 409)
            raise _failure("voice_lab_d02_gateway_database_response_invalid", 503)


def _freeze_local(
    body: D02FreezeRequest,
    *,
    request_sha256: str,
    capability_jti_sha256: str,
) -> dict[str, Any]:
    from app.gateway.routers.sessions import _store
    from deerflow.sophia.cleanup_fence import (
        _LOCAL_ADMISSIONS,
        _LOCAL_D02_PENDING_CLEANUPS,
        _LOCAL_OBLIGATIONS,
    )
    from deerflow.sophia.cleanup_fence import (
        _LOCAL_LOCK as cleanup_lock,
    )

    termination_hash = hashlib.sha256(
        body.termination_request_id.encode("utf-8")
    ).hexdigest()
    key = (body.cleanup_obligation_id, termination_hash)
    with cleanup_lock, _LOCAL_LOCK:
        _register_capability_use(
            None,
            capability_jti_sha256=capability_jti_sha256,
            operation="freeze",
            request_sha256=request_sha256,
            cleanup_obligation_id=body.cleanup_obligation_id,
            termination_request_id_sha256=termination_hash,
        )
        existing = _LOCAL_FREEZES.get(key)
        if existing is not None:
            if (
                existing["freeze_request_sha256"] == request_sha256
                and existing["freeze_binding"] == _freeze_projection(body)
            ):
                return {
                    "frozen": True,
                    "idempotent_replay": True,
                    "freeze_request_sha256": request_sha256,
                }
            raise _failure("voice_lab_d02_freeze_conflict", 409)
        record = _store.find_session_by_cleanup_obligation_id(
            body.cleanup_obligation_id
        )
        obligation = _LOCAL_OBLIGATIONS.get(body.cleanup_obligation_id)
        admissions = [
            item
            for item in _LOCAL_ADMISSIONS.values()
            if item.cleanup_obligation_id == body.cleanup_obligation_id
            and item.resource_kind == "provider"
        ]
        if record is None or obligation is None or len(admissions) != 1:
            raise _failure("voice_lab_d02_freeze_binding_unavailable", 409)
        admission = admissions[0]
        metadata, synthetic = _synthetic_from_metadata(record.metadata)
        if (
            not _session_binding_matches(
                synthetic=synthetic,
                metadata=metadata,
                body=body,
                user_id=record.user_id,
                run_id=record.run_id,
            )
            or obligation.get("state") != "open"
            or obligation.get("lifecycle_phase") != "session_provisional"
            or admission.status not in {"credential_minted", "browser_active"}
            or admission.resource_id != body.provider_session_id
            or hashlib.sha256(admission.admission_id.encode("utf-8")).hexdigest()
            != body.provider_admission_id_sha256
            or _expected_live_epochs(synthetic)
            != body.frozen_provider_connection_epochs
            or synthetic.get("voice_provider_connection_epoch")
            != body.provider_connection_epoch
        ):
            raise _failure("voice_lab_d02_freeze_binding_mismatch", 409)
        now = datetime.now(UTC)
        obligation.update(
            {
                "state": "closed",
                "closed_at": now,
                "updated_at": now,
            }
        )
        _LOCAL_FREEZES[key] = {
            "cleanup_obligation_id": body.cleanup_obligation_id,
            "termination_request_id_sha256": termination_hash,
            "provider_session_id": body.provider_session_id,
            "provider_admission_id": admission.admission_id,
            "freeze_request_sha256": request_sha256,
            "freeze_capability_jti_sha256": capability_jti_sha256,
            "freeze_binding": _freeze_projection(body),
            "settlement_request_sha256": None,
            "settlement_capability_jti_sha256": None,
            "voice_terminal_receipt": None,
            "receipt": None,
        }
        _LOCAL_D02_PENDING_CLEANUPS.add(body.cleanup_obligation_id)
    return {
        "frozen": True,
        "idempotent_replay": False,
        "freeze_request_sha256": request_sha256,
    }


def d02_freeze_for_provider_admission(
    *,
    cleanup_obligation_id: str,
    admission_id: str,
    provider_session_id: str,
) -> dict[str, Any] | None:
    """Return the immutable D02 freeze to the exact owning Voice admission."""

    dsn = _database_url()
    if dsn is None:
        with _LOCAL_LOCK:
            rows = [
                row
                for (cleanup_id, _), row in _LOCAL_FREEZES.items()
                if cleanup_id == cleanup_obligation_id
                and row.get("provider_admission_id") == admission_id
                and row.get("provider_session_id") == provider_session_id
            ]
            if len(rows) != 1:
                return None
            return dict(rows[0]["freeze_binding"])
    import psycopg

    with psycopg.connect(dsn, connect_timeout=5) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT public.sophia_voice_lab_d02_provider_freeze(
                  %s::text, %s::uuid, %s::text
                )
                """,
                (cleanup_obligation_id, admission_id, provider_session_id),
            )
            row = cursor.fetchone()
    if not isinstance(row, tuple) or len(row) != 1:
        raise _failure("voice_lab_d02_gateway_database_response_invalid", 503)
    if row[0] is None:
        return None
    freeze = _json_object(row[0])
    if freeze is None:
        raise _failure("voice_lab_d02_gateway_database_response_invalid", 503)
    return freeze


def assert_d02_producer_open(cleanup_obligation_id: str) -> None:
    """Fail before minting/staging any new D02 provider authority after freeze."""

    dsn = _database_url()
    if dsn is None:
        from deerflow.sophia.cleanup_fence import (
            _LOCAL_LOCK as cleanup_lock,
        )
        from deerflow.sophia.cleanup_fence import (
            _LOCAL_OBLIGATIONS,
        )

        with cleanup_lock, _LOCAL_LOCK:
            obligation = _LOCAL_OBLIGATIONS.get(cleanup_obligation_id)
            frozen = any(key[0] == cleanup_obligation_id for key in _LOCAL_FREEZES)
            if obligation is None or obligation.get("state") != "open" or frozen:
                raise _failure("voice_lab_d02_termination_frozen", 409)
        return
    import psycopg

    with psycopg.connect(dsn, connect_timeout=5) as connection:
        with connection.cursor() as cursor:
            is_open = _d02_rpc_boolean(
                cursor,
                """
                SELECT public.sophia_voice_lab_d02_producer_open(%s::text)
                """,
                (cleanup_obligation_id,),
            )
            if not is_open:
                raise _failure("voice_lab_d02_termination_frozen", 409)


def d02_cleanup_sources_zero(cleanup_obligation_id: str) -> bool:
    """Read-prove that no pending settlement or relay authority remains."""

    if not _CLEANUP_ID.fullmatch(cleanup_obligation_id):
        raise ValueError("D02 cleanup obligation id is malformed")
    dsn = _database_url()
    if dsn is None:
        with _LOCAL_LOCK:
            return not any(
                cleanup_id == cleanup_obligation_id
                and row.get("receipt") is None
                for (cleanup_id, _), row in _LOCAL_FREEZES.items()
            ) and not any(
                row.get("cleanup_obligation_id") == cleanup_obligation_id
                for row in _LOCAL_RELAY_LEASES.values()
            )
    import psycopg

    with psycopg.connect(dsn, connect_timeout=5) as connection:
        with connection.cursor() as cursor:
            return _d02_rpc_boolean(
                cursor,
                """
                SELECT public.sophia_voice_lab_d02_sources_zero(%s::text)
                """,
                (cleanup_obligation_id,),
            )


def persist_d02_voice_terminal_receipt(
    *,
    cleanup_obligation_id: str,
    admission_id: str,
    provider_session_id: str,
    receipt: dict[str, Any],
) -> bool:
    """Persist exact owning-Voice zero proof without consuming the admission."""

    dsn = _database_url()
    if dsn is None:
        from app.gateway.routers.sessions import _store
        from deerflow.sophia.cleanup_fence import (
            _LOCAL_ADMISSIONS,
            _LOCAL_OBLIGATIONS,
        )
        from deerflow.sophia.cleanup_fence import (
            _LOCAL_LOCK as cleanup_lock,
        )

        with cleanup_lock, _LOCAL_LOCK:
            rows = [
                row
                for (cleanup_id, _), row in _LOCAL_FREEZES.items()
                if cleanup_id == cleanup_obligation_id
                and row.get("provider_admission_id") == admission_id
                and row.get("provider_session_id") == provider_session_id
            ]
            if len(rows) != 1:
                raise _failure("voice_lab_d02_freeze_required", 409)
            frozen = rows[0]
            record = _store.find_session_by_cleanup_obligation_id(
                cleanup_obligation_id
            )
            if record is None:
                raise _failure("voice_lab_d02_voice_terminal_binding_mismatch", 409)
            _, synthetic = _synthetic_from_metadata(record.metadata)
            epochs = tuple(
                frozen["freeze_binding"]["frozen_provider_connection_epochs"]
            )
            validated = _validated_terminal_receipt(receipt, synthetic, epochs)
            if (
                validated.get("cleanup_obligation_id") != cleanup_obligation_id
                or validated.get("provider_admission_id") != admission_id
                or validated.get("provider_session_id") != provider_session_id
            ):
                raise _failure("voice_lab_d02_voice_terminal_binding_mismatch", 409)
            stored = frozen.get("voice_terminal_receipt")
            if stored is not None:
                if _canonical_json(stored) != _canonical_json(validated):
                    raise _failure("voice_lab_d02_voice_terminal_replay_conflict", 409)
                return True
            obligation = _LOCAL_OBLIGATIONS.get(cleanup_obligation_id)
            admission = _LOCAL_ADMISSIONS.get(admission_id)
            if (
                obligation is None
                or obligation.get("state") != "closed"
                or admission is None
                or admission.resource_id != provider_session_id
                or admission.status
                not in {
                    "credential_minted",
                    "browser_active",
                    "activation_aborted",
                    "browser_closed",
                }
            ):
                raise _failure("voice_lab_d02_voice_terminal_binding_mismatch", 409)
            if admission.status in {"activation_aborted", "browser_closed"}:
                browser_epochs, browser_settlement_sha256 = (
                    _canonical_browser_terminal_settlement(
                        synthetic,
                        provider_session_id,
                    )
                )
                if (
                    browser_epochs != set(epochs)
                    or obligation.get("provider_settlement_sha256")
                    != browser_settlement_sha256
                ):
                    raise _failure(
                        "voice_lab_d02_voice_terminal_binding_mismatch",
                        409,
                    )
            frozen["voice_terminal_receipt"] = validated
            return True
    import psycopg

    with psycopg.connect(dsn, connect_timeout=5) as connection:
        with connection.cursor() as cursor:
            authorized = _d02_rpc_json(
                cursor,
                """
                SELECT public.sophia_voice_lab_d02_voice_terminal_authorize(
                  %s::text, %s::uuid, %s::text
                )
                """,
                (cleanup_obligation_id, admission_id, provider_session_id),
            )
            status = authorized["status"]
            if status in {"binding_unavailable", "binding_cardinality_invalid"}:
                raise _failure("voice_lab_d02_voice_terminal_binding_mismatch", 409)
            if status not in {"existing", "candidate"}:
                raise _failure(
                    "voice_lab_d02_gateway_database_response_invalid", 503
                )
            freeze_binding = _json_object(authorized.get("freeze_binding"))
            if freeze_binding is None:
                raise _failure("voice_lab_d02_voice_terminal_binding_mismatch", 409)
            _, synthetic = _synthetic_from_metadata(authorized.get("metadata"))
            stored_epochs = freeze_binding.get("frozen_provider_connection_epochs")
            if (
                not isinstance(stored_epochs, list)
                or not stored_epochs
                or any(type(epoch) is not int or epoch <= 0 for epoch in stored_epochs)
            ):
                raise _failure("voice_lab_d02_voice_terminal_binding_mismatch", 409)
            epochs = tuple(stored_epochs)
            validated = _validated_terminal_receipt(receipt, synthetic, epochs)
            if (
                validated.get("cleanup_obligation_id") != cleanup_obligation_id
                or validated.get("provider_admission_id") != admission_id
                or validated.get("provider_session_id") != provider_session_id
            ):
                raise _failure("voice_lab_d02_voice_terminal_binding_mismatch", 409)
            stored = _json_object(authorized.get("voice_terminal_receipt"))
            if status == "existing":
                if stored is None:
                    raise _failure(
                        "voice_lab_d02_gateway_database_response_invalid", 503
                    )
                if _canonical_json(stored) != _canonical_json(validated):
                    raise _failure("voice_lab_d02_voice_terminal_replay_conflict", 409)
                return True
            if (
                stored is not None
                or authorized.get("obligation_state") != "closed"
                or authorized.get("admission_status")
                not in {
                    "credential_minted",
                    "browser_active",
                    "activation_aborted",
                    "browser_closed",
                }
            ):
                raise _failure("voice_lab_d02_voice_terminal_binding_mismatch", 409)
            if authorized.get("admission_status") in {
                "activation_aborted",
                "browser_closed",
            }:
                browser_epochs, browser_settlement_sha256 = (
                    _canonical_browser_terminal_settlement(
                        synthetic,
                        provider_session_id,
                    )
                )
                if (
                    browser_epochs != set(epochs)
                    or authorized.get("provider_settlement_sha256")
                    != browser_settlement_sha256
                ):
                    raise _failure(
                        "voice_lab_d02_voice_terminal_binding_mismatch",
                        409,
                    )
            # `_validated_terminal_receipt` has already recomputed and verified
            # this digest over the unsigned receipt core.  The database seals
            # that same core digest; hashing the signed envelope here would
            # produce a different value and reject every real candidate.
            receipt_sha256 = str(validated["receipt_sha256"])
            authority_key_id, proof = _database_finalize_proof(
                domain="voice_terminal_finalize_v1",
                parts=(cleanup_obligation_id, admission_id, provider_session_id),
                value=validated,
            )
            finalized = _d02_rpc_json(
                cursor,
                """
                SELECT public.sophia_voice_lab_d02_voice_terminal_finalize(
                  %s::text, %s::uuid, %s::text, %s::text, %s::jsonb,
                  %s::text, %s::text
                )
                """,
                (
                    cleanup_obligation_id,
                    admission_id,
                    provider_session_id,
                    receipt_sha256,
                    _canonical_json(validated),
                    authority_key_id,
                    proof,
                ),
            )
            finalize_status = finalized["status"]
            if finalize_status in {"created", "replay"}:
                return True
            if finalize_status == "replay_conflict":
                raise _failure("voice_lab_d02_voice_terminal_replay_conflict", 409)
            if finalize_status == "finalize_proof_invalid":
                _raise_finalize_authority_invalid()
            if finalize_status in {
                "binding_unavailable",
                "binding_cardinality_invalid",
                "binding_mismatch",
            }:
                raise _failure("voice_lab_d02_voice_terminal_binding_mismatch", 409)
            if finalize_status == "write_conflict":
                raise _failure("voice_lab_d02_voice_terminal_conflict", 409)
            raise _failure("voice_lab_d02_gateway_database_response_invalid", 503)


def _settle_database(
    body: D02SettlementRequest,
    *,
    request_sha256: str,
    capability_jti_sha256: str,
) -> dict[str, Any]:
    dsn = _database_url()
    if dsn is None:
        return _settle_local(
            body,
            request_sha256=request_sha256,
            capability_jti_sha256=capability_jti_sha256,
        )
    import psycopg

    termination_hash = hashlib.sha256(
        body.termination_request_id.encode("utf-8")
    ).hexdigest()
    with psycopg.connect(dsn, connect_timeout=5) as connection:
        with connection.cursor() as cursor:
            authorized = _d02_rpc_json(
                cursor,
                """
                SELECT public.sophia_voice_lab_d02_settlement_authorize(
                  %s::text, %s::text, %s::text, %s::text
                )
                """,
                (
                    body.cleanup_obligation_id,
                    termination_hash,
                    request_sha256,
                    capability_jti_sha256,
                ),
            )
            status = authorized["status"]
            if status == "capability_replay_conflict":
                raise _failure("voice_lab_d02_capability_replay_conflict", 409)
            if status == "freeze_required":
                raise _failure("voice_lab_d02_freeze_required", 409)
            if status == "existing":
                if authorized.get("settlement_request_sha256") != request_sha256:
                    raise _failure("voice_lab_d02_settlement_replay_conflict", 409)
                stored_receipt = authorized.get("receipt")
                return _verify_stored_receipt(stored_receipt)
            if status in {"session_unavailable", "binding_cardinality_invalid"}:
                raise _failure("voice_lab_d02_settlement_session_unavailable", 409)
            if status != "candidate":
                raise _failure(
                    "voice_lab_d02_gateway_database_response_invalid", 503
                )
            freeze_binding = _json_object(authorized.get("freeze_binding"))
            provider_admission_id = authorized.get("provider_admission_id")
            if (
                freeze_binding is None
                or _stored_freeze_projection(freeze_binding)
                != _settlement_freeze_projection(body)
                or authorized.get("provider_session_id")
                != body.provider_session_id
                or not isinstance(provider_admission_id, str)
                or _uuid4(provider_admission_id) != provider_admission_id
                or hashlib.sha256(
                    provider_admission_id.encode("utf-8")
                ).hexdigest()
                != body.provider_admission_id_sha256
            ):
                raise _failure("voice_lab_d02_settlement_freeze_conflict", 409)
            metadata, synthetic = _synthetic_from_metadata(
                authorized.get("metadata")
            )
            if not _session_binding_matches(
                synthetic=synthetic,
                metadata=metadata,
                body=body,
                user_id=authorized.get("user_id"),
                run_id=authorized.get("run_id"),
            ):
                raise _failure("voice_lab_d02_settlement_binding_mismatch", 409)
            if (
                authorized.get("obligation_state") != "closed"
                or authorized.get("admission_status")
                not in {"activation_aborted", "browser_closed"}
                or authorized.get("admission_id") != provider_admission_id
                or synthetic.get("voice_provider_resource_state") != "closed"
            ):
                raise _failure("voice_lab_d02_provider_not_terminal", 409)
            frozen_epochs = body.frozen_provider_connection_epochs
            browser_epochs, settlement_sha = _canonical_browser_terminal_settlement(
                synthetic,
                body.provider_session_id,
            )
            if browser_epochs != set(frozen_epochs):
                raise _failure(
                    "voice_lab_d02_browser_terminal_receipts_required", 409
                )
            voice_receipt = _validated_terminal_receipt(
                authorized.get("voice_terminal_receipt"), synthetic, frozen_epochs
            )
            if (
                voice_receipt.get("cleanup_obligation_id")
                != body.cleanup_obligation_id
                or voice_receipt.get("provider_session_id")
                != body.provider_session_id
                or hashlib.sha256(
                    str(voice_receipt.get("provider_admission_id")).encode("utf-8")
                ).hexdigest()
                != body.provider_admission_id_sha256
            ):
                raise _failure("voice_lab_d02_voice_terminal_binding_mismatch", 409)
            if authorized.get("provider_settlement_sha256") != settlement_sha:
                raise _failure("voice_lab_d02_provider_not_terminal", 409)
            if authorized.get("relay_zero") is not True:
                raise _failure("voice_lab_d02_terminal_zero_pending", 409)
            next_synthetic = dict(synthetic)
            next_synthetic.update(
                {
                    "voice_d02_voice_terminal_receipt": voice_receipt,
                    "voice_d02_gateway_provider_settlement_sha256": settlement_sha,
                }
            )
            next_metadata = dict(metadata)
            next_metadata["synthetic_voice_lab"] = next_synthetic
            receipt = _build_receipt(
                body=body,
                metadata=next_metadata,
                synthetic=next_synthetic,
                obligation_state=str(authorized.get("obligation_state")),
                provider_settlement_sha256=settlement_sha,
                voice_terminal_receipt=voice_receipt,
                database_now=_database_observed_at(
                    authorized.get("database_now")
                ),
            )
            receipt_sha256 = _canonical_hash(receipt)
            authority_key_id, proof = _database_finalize_proof(
                domain="settlement_finalize_v1",
                parts=(
                    body.cleanup_obligation_id,
                    termination_hash,
                    body.provider_session_id,
                    provider_admission_id,
                    request_sha256,
                    capability_jti_sha256,
                    settlement_sha,
                ),
                value=receipt,
            )
            finalized = _d02_rpc_json(
                cursor,
                """
                SELECT public.sophia_voice_lab_d02_settlement_finalize(
                  %s::text, %s::text, %s::text, %s::uuid, %s::text,
                  %s::text, %s::text, %s::jsonb, %s::text, %s::jsonb,
                  %s::text, %s::text
                )
                """,
                (
                    body.cleanup_obligation_id,
                    termination_hash,
                    body.provider_session_id,
                    provider_admission_id,
                    request_sha256,
                    capability_jti_sha256,
                    settlement_sha,
                    _canonical_json(next_metadata),
                    receipt_sha256,
                    _canonical_json(receipt),
                    authority_key_id,
                    proof,
                ),
            )
            finalize_status = finalized["status"]
            if finalize_status in {"created", "replay"}:
                return receipt
            if finalize_status == "replay_conflict":
                raise _failure("voice_lab_d02_settlement_replay_conflict", 409)
            if finalize_status in {
                "finalize_proof_invalid",
                "capability_prepare_required",
            }:
                _raise_finalize_authority_invalid()
            if finalize_status == "freeze_required":
                raise _failure("voice_lab_d02_freeze_required", 409)
            if finalize_status in {
                "session_unavailable",
                "binding_cardinality_invalid",
            }:
                raise _failure("voice_lab_d02_settlement_session_unavailable", 409)
            if finalize_status == "binding_mismatch":
                raise _failure("voice_lab_d02_settlement_binding_mismatch", 409)
            if finalize_status == "session_conflict":
                raise _failure("voice_lab_d02_settlement_session_conflict", 409)
            if finalize_status == "admission_conflict":
                raise _failure("voice_lab_d02_settlement_admission_conflict", 409)
            if finalize_status == "settlement_conflict":
                raise _failure("voice_lab_d02_settlement_conflict", 409)
            raise _failure("voice_lab_d02_gateway_database_response_invalid", 503)


def _settle_local(
    body: D02SettlementRequest,
    *,
    request_sha256: str,
    capability_jti_sha256: str,
) -> dict[str, Any]:
    from app.gateway.routers.sessions import _store
    from deerflow.sophia.cleanup_fence import (
        _LOCAL_ADMISSIONS,
        _LOCAL_D02_PENDING_CLEANUPS,
        _LOCAL_OBLIGATIONS,
    )
    from deerflow.sophia.cleanup_fence import (
        _LOCAL_LOCK as cleanup_lock,
    )

    termination_hash = hashlib.sha256(
        body.termination_request_id.encode("utf-8")
    ).hexdigest()
    key = (body.cleanup_obligation_id, termination_hash)
    with cleanup_lock, _LOCAL_LOCK:
        _register_capability_use(
            None,
            capability_jti_sha256=capability_jti_sha256,
            operation="settle",
            request_sha256=request_sha256,
            cleanup_obligation_id=body.cleanup_obligation_id,
            termination_request_id_sha256=termination_hash,
        )
        frozen = _LOCAL_FREEZES.get(key)
        if frozen is None:
            raise _failure("voice_lab_d02_freeze_required", 409)
        stored_receipt = frozen.get("receipt")
        if stored_receipt is not None:
            if frozen.get("settlement_request_sha256") != request_sha256:
                raise _failure("voice_lab_d02_settlement_replay_conflict", 409)
            return _verify_stored_receipt(stored_receipt)
        if (
            _stored_freeze_projection(frozen["freeze_binding"])
            != _settlement_freeze_projection(body)
            or frozen["provider_session_id"] != body.provider_session_id
            or hashlib.sha256(
                frozen["provider_admission_id"].encode("utf-8")
            ).hexdigest()
            != body.provider_admission_id_sha256
        ):
            raise _failure("voice_lab_d02_settlement_freeze_conflict", 409)
        now = datetime.now(UTC)
        record = _store.find_session_by_cleanup_obligation_id(
            body.cleanup_obligation_id
        )
        obligation = _LOCAL_OBLIGATIONS.get(body.cleanup_obligation_id)
        if record is None or obligation is None:
            raise _failure("voice_lab_d02_settlement_session_unavailable", 409)
        metadata, synthetic = _synthetic_from_metadata(record.metadata)
        if not _session_binding_matches(
            synthetic=synthetic,
            metadata=metadata,
            body=body,
            user_id=record.user_id,
            run_id=record.run_id,
        ):
            raise _failure("voice_lab_d02_settlement_binding_mismatch", 409)
        if (
            obligation.get("state") != "closed"
            or synthetic.get("voice_provider_resource_state") != "closed"
        ):
            raise _failure("voice_lab_d02_provider_not_terminal", 409)
        browser_epochs, settlement_sha = _canonical_browser_terminal_settlement(
            synthetic,
            body.provider_session_id,
        )
        if browser_epochs != set(body.frozen_provider_connection_epochs):
            raise _failure(
                "voice_lab_d02_browser_terminal_receipts_required", 409
            )
        voice_receipt = _validated_terminal_receipt(
            frozen.get("voice_terminal_receipt"),
            synthetic,
            body.frozen_provider_connection_epochs,
        )
        if (
            voice_receipt.get("cleanup_obligation_id")
            != body.cleanup_obligation_id
            or voice_receipt.get("provider_session_id") != body.provider_session_id
            or hashlib.sha256(
                str(voice_receipt.get("provider_admission_id")).encode("utf-8")
            ).hexdigest()
            != body.provider_admission_id_sha256
        ):
            raise _failure("voice_lab_d02_voice_terminal_binding_mismatch", 409)
        admission = _LOCAL_ADMISSIONS.get(frozen["provider_admission_id"])
        if (
            admission is None
            or admission.cleanup_obligation_id != body.cleanup_obligation_id
            or admission.resource_kind != "provider"
            or admission.resource_id != body.provider_session_id
            or admission.status not in {"activation_aborted", "browser_closed"}
        ):
            raise _failure("voice_lab_d02_settlement_admission_conflict", 409)
        if any(
            relay["cleanup_obligation_id"] == body.cleanup_obligation_id
            for relay in _LOCAL_RELAY_LEASES.values()
        ):
            raise _failure("voice_lab_d02_terminal_zero_pending", 409)
        if obligation.get("provider_settlement_sha256") != settlement_sha:
            raise _failure("voice_lab_d02_provider_settlement_conflict", 409)
        next_synthetic = dict(synthetic)
        next_synthetic.update(
            {
                "voice_d02_voice_terminal_receipt": voice_receipt,
                "voice_d02_gateway_provider_settlement_sha256": settlement_sha,
            }
        )
        next_metadata = dict(metadata)
        next_metadata["synthetic_voice_lab"] = next_synthetic
        if (
            _store.update(
                record.user_id,
                record.session_id,
                metadata=next_metadata,
            )
            is None
        ):
            raise _failure("voice_lab_d02_settlement_session_conflict", 409)
        _LOCAL_ADMISSIONS.pop(admission.admission_id, None)
        receipt = _build_receipt(
            body=body,
            metadata=next_metadata,
            synthetic=next_synthetic,
            obligation_state=str(obligation["state"]),
            provider_settlement_sha256=settlement_sha,
            voice_terminal_receipt=voice_receipt,
            database_now=now,
        )
        frozen.update(
            {
                "settlement_request_sha256": request_sha256,
                "settlement_capability_jti_sha256": capability_jti_sha256,
                "provider_settlement_sha256": settlement_sha,
                "receipt_sha256": _canonical_hash(receipt),
                "receipt": receipt,
            }
        )
        _LOCAL_D02_PENDING_CLEANUPS.discard(body.cleanup_obligation_id)
        return receipt


def _relay_rpc_boolean_exact_replay(
    dsn: str,
    statement: str,
    parameters: tuple[object, ...],
) -> bool:
    """Retry one ambiguous relay response with the exact same fenced operation."""

    import psycopg

    last_error: Exception | None = None
    for _ in range(2):
        try:
            with psycopg.connect(dsn, connect_timeout=5) as connection:
                with connection.cursor() as cursor:
                    return _d02_rpc_boolean(cursor, statement, parameters)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 - exact replay is DB-fenced.
            last_error = exc
    if last_error is None:
        raise RuntimeError("D02 relay RPC retry state is unavailable")
    raise last_error


def _relay_operation_id_sha256() -> str:
    return hashlib.sha256(secrets.token_bytes(32)).hexdigest()


def _relay_begin_sync(
    *,
    cleanup_obligation_id: str,
    provider_session_id: str,
    provider_connection_epoch: int,
    relay_kind: Literal["provider_event", "event_stream"],
) -> str:
    relay_id = str(uuid.uuid4())
    dsn = _database_url()
    if dsn is None:
        from app.gateway.routers.sessions import _store
        from deerflow.sophia.cleanup_fence import (
            _LOCAL_ADMISSIONS,
            _LOCAL_OBLIGATIONS,
        )
        from deerflow.sophia.cleanup_fence import (
            _LOCAL_LOCK as cleanup_lock,
        )

        with cleanup_lock, _LOCAL_LOCK:
            obligation = _LOCAL_OBLIGATIONS.get(cleanup_obligation_id)
            record = _store.find_session_by_cleanup_obligation_id(
                cleanup_obligation_id
            )
            metadata = getattr(record, "metadata", None)
            synthetic = (
                metadata.get("synthetic_voice_lab")
                if isinstance(metadata, dict)
                else None
            )
            exact_epochs = (
                _expected_live_epochs(synthetic)
                if isinstance(synthetic, dict)
                else ()
            )
            admissions = [
                item
                for item in _LOCAL_ADMISSIONS.values()
                if item.cleanup_obligation_id == cleanup_obligation_id
                and item.resource_kind == "provider"
                and item.resource_id == provider_session_id
                and (
                    item.status == "browser_active"
                    or (
                        relay_kind == "event_stream"
                        and item.status == "credential_minted"
                    )
                )
            ]
            has_freeze = any(
                key[0] == cleanup_obligation_id for key in _LOCAL_FREEZES
            )
            if (
                obligation is None
                or obligation.get("state") != "open"
                or len(admissions) != 1
                or has_freeze
                or provider_connection_epoch not in exact_epochs
            ):
                raise _failure("voice_lab_d02_gateway_relay_closed", 409)
            _LOCAL_RELAY_LEASES[relay_id] = {
                "cleanup_obligation_id": cleanup_obligation_id,
                "provider_session_id": provider_session_id,
                "provider_connection_epoch": provider_connection_epoch,
                "relay_kind": relay_kind,
                "owner_instance_id_sha256": (
                    _GATEWAY_RELAY_OWNER_INSTANCE_ID_SHA256
                ),
                "expires_at": datetime.now(UTC)
                + timedelta(seconds=_RELAY_LEASE_SECONDS),
            }
            from deerflow.sophia.cleanup_fence import _register_local_d02_relay

            _register_local_d02_relay(relay_id, cleanup_obligation_id)
            return relay_id
    authority_key_id, proof = _database_finalize_proof(
        domain="relay_begin_v1",
        parts=(
            cleanup_obligation_id,
            relay_id,
            provider_session_id,
            str(provider_connection_epoch),
            relay_kind,
            _GATEWAY_RELAY_OWNER_INSTANCE_ID_SHA256,
            str(_RELAY_LEASE_SECONDS),
        ),
        value={},
    )
    created = _relay_rpc_boolean_exact_replay(
        dsn,
        """
        SELECT public.sophia_voice_lab_d02_relay_begin(
          %s::uuid, %s::text, %s::text, %s::integer, %s::text,
          %s::text, %s::integer, %s::text, %s::text
        )
        """,
        (
            relay_id,
            cleanup_obligation_id,
            provider_session_id,
            provider_connection_epoch,
            relay_kind,
            _GATEWAY_RELAY_OWNER_INSTANCE_ID_SHA256,
            _RELAY_LEASE_SECONDS,
            authority_key_id,
            proof,
        ),
    )
    if not created:
        raise _failure("voice_lab_d02_gateway_relay_closed", 409)
    return relay_id


def _relay_end_sync(
    relay_id: str,
    cleanup_obligation_id: str,
    operation_lock: threading.Lock,
) -> None:
    with operation_lock:
        dsn = _database_url()
        if dsn is None:
            relay_removed = False
            with _LOCAL_LOCK:
                relay = _LOCAL_RELAY_LEASES.get(relay_id)
                if (
                    relay is not None
                    and relay.get("cleanup_obligation_id")
                    == cleanup_obligation_id
                    and relay.get("owner_instance_id_sha256")
                    == _GATEWAY_RELAY_OWNER_INSTANCE_ID_SHA256
                ):
                    _LOCAL_RELAY_LEASES.pop(relay_id, None)
                    relay_removed = True
            if relay_removed:
                from deerflow.sophia.cleanup_fence import (
                    _unregister_local_d02_relay,
                )

                _unregister_local_d02_relay(relay_id)
            return
        operation_id_sha256 = _relay_operation_id_sha256()
        authority_key_id, proof = _database_finalize_proof(
            domain="relay_end_v1",
            parts=(
                cleanup_obligation_id,
                relay_id,
                _GATEWAY_RELAY_OWNER_INSTANCE_ID_SHA256,
                operation_id_sha256,
            ),
            value={},
        )
        ended = _relay_rpc_boolean_exact_replay(
            dsn,
            """
            SELECT public.sophia_voice_lab_d02_relay_end(
              %s::uuid, %s::text, %s::text, %s::text, %s::text, %s::text
            )
            """,
            (
                relay_id,
                cleanup_obligation_id,
                _GATEWAY_RELAY_OWNER_INSTANCE_ID_SHA256,
                operation_id_sha256,
                authority_key_id,
                proof,
            ),
        )
        if not ended:
            raise RuntimeError("D02 relay end authority was rejected")


def _relay_refresh_sync(
    relay_id: str,
    cleanup_obligation_id: str,
    operation_lock: threading.Lock,
) -> bool:
    with operation_lock:
        dsn = _database_url()
        if dsn is None:
            with _LOCAL_LOCK:
                relay = _LOCAL_RELAY_LEASES.get(relay_id)
                now = datetime.now(UTC)
                if (
                    relay is None
                    or relay.get("cleanup_obligation_id")
                    != cleanup_obligation_id
                    or relay.get("owner_instance_id_sha256")
                    != _GATEWAY_RELAY_OWNER_INSTANCE_ID_SHA256
                    or relay["expires_at"] <= now
                ):
                    return False
                relay["expires_at"] = now + timedelta(
                    seconds=_RELAY_LEASE_SECONDS
                )
                return True
        operation_id_sha256 = _relay_operation_id_sha256()
        authority_key_id, proof = _database_finalize_proof(
            domain="relay_refresh_v1",
            parts=(
                cleanup_obligation_id,
                relay_id,
                _GATEWAY_RELAY_OWNER_INSTANCE_ID_SHA256,
                str(_RELAY_LEASE_SECONDS),
                operation_id_sha256,
            ),
            value={},
        )
        return _relay_rpc_boolean_exact_replay(
            dsn,
            """
            SELECT public.sophia_voice_lab_d02_relay_refresh(
              %s::uuid, %s::text, %s::text, %s::integer, %s::text,
              %s::text, %s::text
            )
            """,
            (
                relay_id,
                cleanup_obligation_id,
                _GATEWAY_RELAY_OWNER_INSTANCE_ID_SHA256,
                _RELAY_LEASE_SECONDS,
                operation_id_sha256,
                authority_key_id,
                proof,
            ),
        )


@dataclass
class D02RelayLease:
    relay_id: str | None
    cleanup_obligation_id: str | None = None
    _operation_lock: threading.Lock | None = None
    _lost: asyncio.Event | None = None
    _owner_task: asyncio.Task[Any] | None = None

    def bind_current_task(self) -> None:
        self._owner_task = asyncio.current_task()

    async def assert_live(self) -> None:
        if self.relay_id is None:
            return
        if self.cleanup_obligation_id is None or self._operation_lock is None:
            raise _failure("voice_lab_d02_gateway_relay_lease_lost", 503)
        if self._lost is not None and self._lost.is_set():
            raise _failure("voice_lab_d02_gateway_relay_lease_lost", 503)
        try:
            alive = await asyncio.to_thread(
                _relay_refresh_sync,
                self.relay_id,
                self.cleanup_obligation_id,
                self._operation_lock,
            )
        except Exception as exc:  # noqa: BLE001 - relay authority is fail-stop.
            if self._lost is not None:
                self._lost.set()
            raise _failure("voice_lab_d02_gateway_relay_lease_lost", 503) from exc
        if not alive:
            if self._lost is not None:
                self._lost.set()
            raise _failure("voice_lab_d02_gateway_relay_lease_lost", 503)


@asynccontextmanager
async def gateway_d02_relay_lease(
    *,
    cleanup_obligation_id: str,
    provider_session_id: str,
    provider_connection_epoch: int,
    scenario_id: str | None,
    relay_kind: Literal["provider_event", "event_stream"],
) -> AsyncIterator[D02RelayLease]:
    """Fence cross-replica Gateway relay in-flight state for D02 only."""

    if scenario_id != "V-D02":
        yield D02RelayLease(relay_id=None)
        return
    relay_id = await asyncio.to_thread(
        _relay_begin_sync,
        cleanup_obligation_id=cleanup_obligation_id,
        provider_session_id=provider_session_id,
        provider_connection_epoch=provider_connection_epoch,
        relay_kind=relay_kind,
    )
    lost = asyncio.Event()
    operation_lock = threading.Lock()
    lease = D02RelayLease(
        relay_id=relay_id,
        cleanup_obligation_id=cleanup_obligation_id,
        _operation_lock=operation_lock,
        _lost=lost,
        _owner_task=asyncio.current_task(),
    )

    async def renew() -> None:
        while True:
            await asyncio.sleep(_RELAY_LEASE_SECONDS / 3)
            try:
                alive = await asyncio.to_thread(
                    _relay_refresh_sync,
                    relay_id,
                    cleanup_obligation_id,
                    operation_lock,
                )
            except Exception:  # noqa: BLE001 - cancel the relay producer.
                alive = False
            if not alive:
                lost.set()
                if lease._owner_task is not None:
                    lease._owner_task.cancel(
                        "voice_lab_d02_gateway_relay_lease_lost"
                    )
                return

    renewer = asyncio.create_task(
        renew(),
        name=f"voice-lab-d02-relay-{relay_id}",
    )
    try:
        yield lease
    except asyncio.CancelledError as exc:
        if lost.is_set():
            raise _failure("voice_lab_d02_gateway_relay_lease_lost", 503) from exc
        raise
    finally:
        renewer.cancel()
        await asyncio.gather(renewer, return_exceptions=True)
        try:
            await asyncio.shield(
                asyncio.to_thread(
                    _relay_end_sync,
                    relay_id,
                    cleanup_obligation_id,
                    operation_lock,
                )
            )
        except Exception:  # noqa: BLE001 - surviving row blocks settlement.
            pass


def _observe_continuity_local(
    body: D02ContinuityObservationRequest,
    *,
    request_sha256: str,
    capability_jti_sha256: str,
) -> dict[str, Any]:
    from app.gateway.routers.sessions import _store
    from deerflow.sophia.cleanup_fence import _LOCAL_ADMISSIONS, _LOCAL_OBLIGATIONS
    from deerflow.sophia.cleanup_fence import _LOCAL_LOCK as cleanup_lock

    restart_hash = hashlib.sha256(body.restart_request_id.encode()).hexdigest()
    key = (body.cleanup_obligation_id, restart_hash, body.phase)
    with cleanup_lock, _LOCAL_LOCK:
        existing = _LOCAL_CONTINUITY_OBSERVATIONS.get(key)
        if existing is not None:
            _register_capability_use(
                None,
                capability_jti_sha256=capability_jti_sha256,
                operation="observe_continuity",
                request_sha256=request_sha256,
                cleanup_obligation_id=body.cleanup_obligation_id,
                termination_request_id_sha256=restart_hash,
            )
            if existing["request_sha256"] != request_sha256:
                raise _failure("voice_lab_d02_continuity_replay_conflict", 409)
            return _verify_stored_receipt(existing["receipt"])
        database_now = _utc_now()
        _require_fresh_continuity_observation(
            body.observed_at,
            database_now=database_now,
        )
        _register_capability_use(
            None,
            capability_jti_sha256=capability_jti_sha256,
            operation="observe_continuity",
            request_sha256=request_sha256,
            cleanup_obligation_id=body.cleanup_obligation_id,
            termination_request_id_sha256=restart_hash,
        )
        if body.phase == "before_api_restart" and any(
            cleanup_id == body.cleanup_obligation_id
            and phase == "before_api_restart"
            for cleanup_id, _, phase in _LOCAL_CONTINUITY_OBSERVATIONS
        ):
            raise _failure("voice_lab_d02_continuity_restart_conflict", 409)
        if any(
            cleanup_id == body.cleanup_obligation_id
            for cleanup_id, _ in _LOCAL_FREEZES
        ):
            raise _failure("voice_lab_d02_continuity_freeze_conflict", 409)
        obligation = _LOCAL_OBLIGATIONS.get(body.cleanup_obligation_id)
        record = _store.find_session_by_cleanup_obligation_id(
            body.cleanup_obligation_id
        )
        admissions = [
            admission
            for admission in _LOCAL_ADMISSIONS.values()
            if admission.cleanup_obligation_id == body.cleanup_obligation_id
            and admission.resource_kind == "provider"
        ]
        if (
            obligation is None
            or obligation.get("state") != "open"
            or obligation.get("lifecycle_phase") != "session_provisional"
            or record is None
            or len(admissions) != 1
        ):
            raise _failure("voice_lab_d02_continuity_unavailable", 409)
        admission = admissions[0]
        projection = _continuity_projection(
            session_id=record.session_id,
            thread_id=record.thread_id,
            user_id=record.user_id,
            run_id=record.run_id,
            status=getattr(record, "status", None),
            message_revision=getattr(record, "message_revision", None),
            metadata_value=record.metadata,
            admission_id=admission.admission_id,
            admission_status=admission.status,
            admission_resource_id=admission.resource_id,
            cleanup_obligation_id=body.cleanup_obligation_id,
        )
        if body.phase == "after_api_restart":
            before = _LOCAL_CONTINUITY_OBSERVATIONS.get(
                (
                    body.cleanup_obligation_id,
                    restart_hash,
                    "before_api_restart",
                )
            )
            if (
                before is None
                or before["receipt"].get("receipt_sha256")
                != body.prior_observation_receipt_sha256
                or before["receipt"].get("continuity_projection") != projection
            ):
                raise _failure("voice_lab_d02_continuity_changed", 409)
        receipt = _build_continuity_receipt(
            body=body,
            request_sha256=request_sha256,
            projection=projection,
            database_now=database_now,
        )
        _LOCAL_CONTINUITY_OBSERVATIONS[key] = {
            "request_sha256": request_sha256,
            "capability_jti_sha256": capability_jti_sha256,
            "receipt": receipt,
        }
        return receipt


def _observe_continuity_database(
    body: D02ContinuityObservationRequest,
    *,
    request_sha256: str,
    capability_jti_sha256: str,
) -> dict[str, Any]:
    dsn = _database_url()
    if dsn is None:
        return _observe_continuity_local(
            body,
            request_sha256=request_sha256,
            capability_jti_sha256=capability_jti_sha256,
        )
    import psycopg

    restart_hash = hashlib.sha256(body.restart_request_id.encode()).hexdigest()
    with psycopg.connect(dsn, connect_timeout=5) as connection:
        with connection.cursor() as cursor:
            authorized = _d02_rpc_json(
                cursor,
                """
                SELECT public.sophia_voice_lab_d02_continuity_authorize(
                  %s::text, %s::text, %s::text, %s::text, %s::text,
                  %s::timestamptz
                )
                """,
                (
                    body.cleanup_obligation_id,
                    restart_hash,
                    body.phase,
                    request_sha256,
                    capability_jti_sha256,
                    body.observed_at,
                ),
            )
            status = authorized["status"]
            if status == "existing":
                if authorized.get("request_sha256") != request_sha256:
                    raise _failure(
                        "voice_lab_d02_continuity_replay_conflict", 409
                    )
                return _verify_stored_receipt(authorized.get("receipt"))
            if status == "stale":
                raise _failure(
                    "voice_lab_d02_continuity_observation_stale", 409
                )
            if status == "capability_replay_conflict":
                raise _failure("voice_lab_d02_capability_replay_conflict", 409)
            if status == "restart_conflict":
                raise _failure("voice_lab_d02_continuity_restart_conflict", 409)
            if status in {"unavailable", "binding_cardinality_invalid"}:
                raise _failure("voice_lab_d02_continuity_unavailable", 409)
            if status == "before_missing":
                raise _failure("voice_lab_d02_continuity_changed", 409)
            if status != "candidate":
                raise _failure(
                    "voice_lab_d02_gateway_database_response_invalid", 503
                )
            if (
                authorized.get("obligation_state") != "open"
                or authorized.get("lifecycle_phase") != "session_provisional"
            ):
                raise _failure("voice_lab_d02_continuity_unavailable", 409)
            projection = _continuity_projection(
                session_id=authorized.get("session_id"),
                thread_id=authorized.get("thread_id"),
                user_id=authorized.get("user_id"),
                run_id=authorized.get("run_id"),
                status=authorized.get("session_status"),
                message_revision=authorized.get("message_revision"),
                metadata_value=authorized.get("metadata"),
                admission_id=authorized.get("admission_id"),
                admission_status=authorized.get("admission_status"),
                admission_resource_id=authorized.get("admission_resource_id"),
                cleanup_obligation_id=body.cleanup_obligation_id,
            )
            if body.phase == "after_api_restart":
                before = _json_object(authorized.get("before_receipt"))
                if (
                    before is None
                    or before.get("receipt_sha256")
                    != body.prior_observation_receipt_sha256
                    or before.get("continuity_projection") != projection
                ):
                    raise _failure("voice_lab_d02_continuity_changed", 409)
            receipt = _build_continuity_receipt(
                body=body,
                request_sha256=request_sha256,
                projection=projection,
                database_now=_database_observed_at(
                    authorized.get("database_now")
                ),
            )
            receipt_sha256 = str(receipt["receipt_sha256"])
            prior_receipt_sha256 = (
                body.prior_observation_receipt_sha256 or "<none>"
            )
            authority_key_id, proof = _database_finalize_proof(
                domain="continuity_finalize_v1",
                parts=(
                    body.cleanup_obligation_id,
                    restart_hash,
                    body.phase,
                    request_sha256,
                    capability_jti_sha256,
                    body.product_service_boot_id_sha256,
                    body.render_action_request_sha256,
                    prior_receipt_sha256,
                    receipt_sha256,
                ),
                value=receipt,
            )
            finalized = _d02_rpc_json(
                cursor,
                """
                SELECT public.sophia_voice_lab_d02_continuity_finalize(
                  %s::text, %s::text, %s::text, %s::text, %s::text,
                  %s::text, %s::text, %s::text, %s::text, %s::jsonb,
                  %s::text, %s::text
                )
                """,
                (
                    body.cleanup_obligation_id,
                    restart_hash,
                    body.phase,
                    request_sha256,
                    capability_jti_sha256,
                    body.product_service_boot_id_sha256,
                    body.render_action_request_sha256,
                    body.prior_observation_receipt_sha256,
                    receipt_sha256,
                    _canonical_json(receipt),
                    authority_key_id,
                    proof,
                ),
            )
            finalize_status = finalized["status"]
            if finalize_status in {"created", "replay"}:
                return receipt
            if finalize_status == "replay_conflict":
                raise _failure(
                    "voice_lab_d02_continuity_replay_conflict", 409
                )
            if finalize_status in {
                "finalize_proof_invalid",
                "capability_prepare_required",
            }:
                _raise_finalize_authority_invalid()
            if finalize_status == "restart_conflict":
                raise _failure("voice_lab_d02_continuity_restart_conflict", 409)
            if finalize_status in {
                "unavailable",
                "binding_cardinality_invalid",
            }:
                raise _failure("voice_lab_d02_continuity_unavailable", 409)
            if finalize_status == "binding_mismatch":
                raise _failure("voice_lab_d02_continuity_binding_invalid", 409)
            if finalize_status in {
                "phase_chain_conflict",
                "before_missing",
                "continuity_changed",
            }:
                raise _failure("voice_lab_d02_continuity_changed", 409)
            raise _failure("voice_lab_d02_gateway_database_response_invalid", 503)


def reset_d02_local_state_for_tests() -> None:
    from deerflow.sophia.cleanup_fence import (
        _LOCAL_D02_PENDING_CLEANUPS,
        _clear_local_d02_relays_for_tests,
    )
    from deerflow.sophia.cleanup_fence import _LOCAL_LOCK as cleanup_lock

    # Match the local production mutation order (cleanup fence -> router) so
    # a concurrent begin cannot survive reset with its mirror erased.
    with cleanup_lock, _LOCAL_LOCK:
        _LOCAL_FREEZES.clear()
        _LOCAL_CONTINUITY_OBSERVATIONS.clear()
        _LOCAL_RELAY_LEASES.clear()
        _LOCAL_CAPABILITY_USES.clear()
        _LOCAL_D02_PENDING_CLEANUPS.clear()
        _clear_local_d02_relays_for_tests()


@router.post("/product-continuity-observations", status_code=202)
def observe_product_continuity(
    body: D02ContinuityObservationRequest,
    request: Request,
) -> dict[str, Any]:
    body_dict = _request_dict(body)
    request_sha = _canonical_hash(body_dict)
    restart_hash = hashlib.sha256(body.restart_request_id.encode()).hexdigest()
    jti_sha = _verify_capability(
        request,
        operation="observe_continuity",
        request_sha256=request_sha,
        cleanup_obligation_id=body.cleanup_obligation_id,
        termination_request_id_sha256=restart_hash,
    )
    return _observe_continuity_database(
        body,
        request_sha256=request_sha,
        capability_jti_sha256=jti_sha,
    )


@router.post("/browser-worker-termination-freezes", status_code=202)
def freeze_browser_worker_termination(
    body: D02FreezeRequest,
    request: Request,
) -> dict[str, Any]:
    body_dict = _request_dict(body)
    request_sha = _canonical_hash(body_dict)
    termination_hash = hashlib.sha256(
        body.termination_request_id.encode("utf-8")
    ).hexdigest()
    jti_sha = _verify_capability(
        request,
        operation="freeze",
        request_sha256=request_sha,
        cleanup_obligation_id=body.cleanup_obligation_id,
        termination_request_id_sha256=termination_hash,
    )
    return _freeze_database(
        body,
        request_sha256=request_sha,
        capability_jti_sha256=jti_sha,
    )


@router.post("/browser-worker-termination-settlements", status_code=202)
def settle_browser_worker_termination(
    body: D02SettlementRequest,
    request: Request,
) -> dict[str, Any]:
    body_dict = _request_dict(body)
    request_sha = _canonical_hash(body_dict)
    termination_hash = hashlib.sha256(
        body.termination_request_id.encode("utf-8")
    ).hexdigest()
    jti_sha = _verify_capability(
        request,
        operation="settle",
        request_sha256=request_sha,
        cleanup_obligation_id=body.cleanup_obligation_id,
        termination_request_id_sha256=termination_hash,
    )
    return _settle_database(
        body,
        request_sha256=request_sha,
        capability_jti_sha256=jti_sha,
    )
