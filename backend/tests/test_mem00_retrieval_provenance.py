from types import SimpleNamespace
from uuid import UUID

import pytest
from mem00_owner_fixture import declare_memory_owners

from deerflow.sophia.memory_governance.models import AuthorizedMemory
from deerflow.sophia.memory_governance.refs import keyed_ref
from deerflow.sophia.memory_governance.retrieval_provenance import RETRIEVAL_PROOF_KEY, issue_retrieval_proof, verify_retrieval_proof


@pytest.fixture
def fixture(monkeypatch):
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "synthetic-retrieval-key-" * 3)
    item = AuthorizedMemory(memory_id=UUID(int=1), content_revision=2, memory_governance_revision=4, canonical_content="Synthetic approved canonical value")
    receipt = SimpleNamespace(owner_ref=keyed_ref("owner", "owner"), provider_status="ok", prompt_admission_id=UUID(int=2),
        revocation_epoch_checked=7, authorized_memory_ids=(keyed_ref("memory-revision", f"{item.memory_id}:2:4"),))
    proof = issue_retrieval_proof(owner_id="owner", memories=(item,), receipt=receipt)
    return item, receipt, proof


def test_proof_is_content_free_and_preserves_exact_revisions(fixture):
    item, _, proof = fixture
    assert item.canonical_content not in str(proof)
    manifest = verify_retrieval_proof(owner_id="owner", proof=proof, rendered_text="- " + item.canonical_content)
    assert manifest.revocation_epoch == 7
    assert manifest.inclusions[0].content_revision == 2
    assert manifest.inclusions[0].governance_revision == 4


@pytest.mark.parametrize("owner,text", [("other", "- Synthetic approved canonical value"), ("owner", "- Provider text"), ("owner", "")])
def test_wrong_owner_or_rendered_text_denied(fixture, owner, text):
    assert verify_retrieval_proof(owner_id=owner, proof=fixture[2], rendered_text=text) is None


@pytest.mark.parametrize("field,value", [("prompt_admission_id", None), ("owner_ref", "other"), ("provider_status", "unavailable"), ("authorized_memory_ids", ())])
def test_missing_atomic_receipt_or_mismatched_manifest_cannot_be_sealed(fixture, field, value):
    item, receipt, _ = fixture
    setattr(receipt, field, value)
    with pytest.raises(ValueError):
        issue_retrieval_proof(owner_id="owner", memories=(item,), receipt=receipt)


def test_governed_tool_carries_proof_in_artifact_not_rendered_text(fixture, monkeypatch):
    from langchain_core.messages import ToolMessage

    from deerflow.sophia.tools.retrieve_memories import make_retrieve_memories_tool
    item, _, proof = fixture
    monkeypatch.setattr("deerflow.sophia.memory_governance.flags.memory_feature_flags_for_owner", lambda owner: SimpleNamespace(canonical_pool_read=True))
    monkeypatch.setattr("deerflow.sophia.mem0_client.search_memories_with_diagnostics", lambda **kwargs: {
        "memories": [{"content": item.canonical_content, RETRIEVAL_PROOF_KEY: proof}], "provider_status": "ok"})
    tool = make_retrieve_memories_tool("owner")
    result = tool.invoke({"type": "tool_call", "name": "retrieve_memories", "id": "synthetic-call", "args": {"query": "synthetic query"}})
    assert isinstance(result, ToolMessage)
    assert result.content == "- " + item.canonical_content
    assert result.artifact == {RETRIEVAL_PROOF_KEY: proof}
    assert "hmac-sha256" not in result.content


def test_governed_tool_rejects_unbound_provider_looking_text(fixture, monkeypatch):
    from deerflow.sophia.tools.retrieve_memories import make_retrieve_memories_tool
    monkeypatch.setattr("deerflow.sophia.memory_governance.flags.memory_feature_flags_for_owner", lambda owner: SimpleNamespace(canonical_pool_read=True))
    monkeypatch.setattr("deerflow.sophia.mem0_client.search_memories_with_diagnostics", lambda **kwargs: {"memories": [{"content": "unbound"}], "provider_status": "ok"})
    assert make_retrieve_memories_tool("owner").invoke({"query": "synthetic query"}) == "Memory retrieval temporarily unavailable."


@pytest.mark.parametrize("mutation", ["text", "id", "owner", "duplicate", "unknown_selection", "missing_proof"])
def test_subset_rejects_unproven_source_or_added_identity(fixture, mutation):
    from deerflow.sophia.memory_governance.retrieval_provenance import select_retrieval_proof

    item, _, proof = fixture
    rows = [{"id": str(item.memory_id), "content": item.canonical_content, RETRIEVAL_PROOF_KEY: proof}]
    selected = [str(item.memory_id)]
    owner = "other" if mutation == "owner" else "owner"
    if mutation == "text":
        rows[0]["content"] += " forged"
    if mutation == "id":
        rows[0]["id"] = str(UUID(int=999))
    if mutation == "duplicate":
        rows += rows
    if mutation == "unknown_selection":
        selected = [str(UUID(int=999))]
    if mutation == "missing_proof":
        rows[0].pop(RETRIEVAL_PROOF_KEY)
    with pytest.raises(ValueError, match="retrieval_subset_unproven"):
        select_retrieval_proof(owner_id=owner, rows=rows, selected_ids=selected)


def test_subset_can_remove_but_not_approve_memories(fixture):
    from deerflow.sophia.memory_governance.retrieval_provenance import select_retrieval_proof

    item, _, proof = fixture
    rows = [{"id": str(item.memory_id), "content": item.canonical_content, RETRIEVAL_PROOF_KEY: proof}]
    empty = select_retrieval_proof(owner_id="owner", rows=rows, selected_ids=[])
    manifest = verify_retrieval_proof(owner_id="owner", proof=empty, rendered_text="")
    assert manifest.inclusions == ()
    assert manifest.revocation_epoch == 7
    same = select_retrieval_proof(owner_id="owner", rows=rows, selected_ids=[str(item.memory_id)])
    assert same == proof


@pytest.mark.parametrize("owner_state", ["governed", "unknown"])
@pytest.mark.parametrize("recall_enabled", [False, True])
def test_pilot_builder_denies_personal_memory(fixture, monkeypatch, declare_memory_owners, owner_state, recall_enabled):
    import asyncio

    from langchain_core.messages import HumanMessage

    from deerflow.agents.sophia_agent.middlewares.mem0_retrieval import BuilderMem0RetrievalMiddleware
    declare_memory_owners({"owner": "governed"} if owner_state == "governed" else {})
    monkeypatch.setattr("deerflow.sophia.memory_governance.flags.memory_feature_flags_for_owner", lambda owner: SimpleNamespace(canonical_pool_read=True, governed_runtime_read=recall_enabled))
    middleware = BuilderMem0RetrievalMiddleware()

    async def lookup(*args):
        pytest.fail("C2 Builder must not search personal memory")

    monkeypatch.setattr(middleware, "_safe_search", lookup)
    state = {"user_id": "owner", "messages": [HumanMessage(content="Synthetic task")],
             "injected_memories": ["old"], "injected_memory_contents": ["old personal memory"],
             "system_prompt_blocks": ["<memory>old personal memory</memory>", "Independent task instructions"]}
    runtime = SimpleNamespace(context={"user_id": "owner"})
    update = asyncio.run(middleware.abefore_agent(state, runtime))
    assert update["injected_memories"] == []
    assert update["injected_memory_contents"] == []
    assert "messages" not in update
    assert update["system_prompt_blocks"] == ["Independent task instructions"]
    assert middleware.before_agent(state, runtime) == update
