"""Content-free provenance carried from a canonical reader to its consumers.

This signature is not current consent. Consumers must re-admit the exact
inclusion union through canonical governance immediately before consumption.
"""

import hmac
import json
from dataclasses import replace
from uuid import UUID

from .refs import keyed_ref
from .retained_context import MemoryInclusion, RetainedMemoryContext, decode_context_manifest, encode_context_manifest

RETRIEVAL_PROOF_KEY = "memory_retrieval_proof"


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def issue_retrieval_proof(*, owner_id, memories, receipt):
    """Canonical-reader facade only, after an atomic admission receipt exists."""
    owner_ref = keyed_ref("owner", owner_id)
    if receipt.owner_ref != owner_ref or receipt.provider_status != "ok" or not isinstance(receipt.prompt_admission_id, UUID):
        raise ValueError("retrieval_admission_required")
    inclusions = tuple(MemoryInclusion(item.memory_id, item.content_revision, item.memory_governance_revision) for item in memories)
    expected = {keyed_ref("memory-revision", f"{item.memory_id}:{item.content_revision}:{item.governance_revision}") for item in inclusions}
    if not expected.issubset(set(receipt.authorized_memory_ids)):
        raise ValueError("retrieval_manifest_not_admitted")
    manifest = encode_context_manifest(RetainedMemoryContext(owner_ref, receipt.revocation_epoch_checked, inclusions))
    text = "\n".join("- " + item.canonical_content for item in memories)
    body = {"schema": "mem00.retrieval-provenance.v1", "manifest": manifest,
        "rendered_ref": keyed_ref("retrieval-rendered", text), "admission_ref": keyed_ref("prompt-admission", str(receipt.prompt_admission_id))}
    return {**body, "seal": keyed_ref("retrieval-seal", _json(body))}


def verify_retrieval_proof(*, owner_id, proof, rendered_text):
    try:
        if not isinstance(proof, dict) or set(proof) != {"schema", "manifest", "rendered_ref", "admission_ref", "seal"} or proof["schema"] != "mem00.retrieval-provenance.v1":
            return None
        manifest = decode_context_manifest(proof["manifest"])
        if manifest is None or manifest.owner_ref != keyed_ref("owner", owner_id) or proof["rendered_ref"] != keyed_ref("retrieval-rendered", rendered_text):
            return None
        body = {key: value for key, value in proof.items() if key != "seal"}
        if not isinstance(proof["seal"], str) or not hmac.compare_digest(proof["seal"], keyed_ref("retrieval-seal", _json(body))):
            return None
        return manifest
    except Exception:
        return None


def select_retrieval_proof(*, owner_id, rows, selected_ids):
    """Attenuate an exact canonical-reader result; never bless new text/IDs.

    Local consumer filters may remove results, but may not trim or substitute
    their text. Current consent still requires independent canonical re-admission.
    """
    try:
        if not isinstance(rows, list) or not rows or len(rows) > 100:
            raise ValueError()
        ids = [UUID(row["id"]) for row in rows]
        if len(set(ids)) != len(ids) or any(not isinstance(row["content"], str) for row in rows):
            raise ValueError()
        proof = rows[0][RETRIEVAL_PROOF_KEY]
        if any(row.get(RETRIEVAL_PROOF_KEY) != proof for row in rows):
            raise ValueError()
        rendered = "\n".join("- " + row["content"] for row in rows)
        manifest = verify_retrieval_proof(owner_id=owner_id, proof=proof, rendered_text=rendered)
        if manifest is None or [item.memory_id for item in manifest.inclusions] != ids:
            raise ValueError()
        wanted = [UUID(value) for value in selected_ids]
        if len(set(wanted)) != len(wanted) or not set(wanted).issubset(ids):
            raise ValueError()
        indexes = [ids.index(value) for value in wanted]
        subset = replace(manifest, inclusions=tuple(manifest.inclusions[index] for index in indexes))
        body = {**{key: value for key, value in proof.items() if key != "seal"},
            "manifest": encode_context_manifest(subset),
            "rendered_ref": keyed_ref("retrieval-rendered", "\n".join("- " + rows[index]["content"] for index in indexes))}
        return {**body, "seal": keyed_ref("retrieval-seal", _json(body))}
    except Exception:
        raise ValueError("retrieval_subset_unproven") from None
