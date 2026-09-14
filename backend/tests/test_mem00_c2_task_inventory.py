import asyncio
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

from test_update_async_task_wrapper import _make_native_list_tool, _runtime
from test_mem00_c2_builder_source import source
from deerflow.sophia.tools import update_async_task_wrapper as wrapper


@pytest.mark.parametrize('operation', ['entry', 'execution', 'checkpoint', 'source'])
def test_deferred_c1_execution_is_explicitly_unavailable(monkeypatch, operation):
    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryRunGuard, MemoryContextUnavailable
    monkeypatch.setattr('deerflow.sophia.memory_governance.context_state.allows_unversioned_builder_handoff', lambda owner: False)
    guard = MemoryRunGuard(owner_id='synthetic-owner', config={'thread_id': str(uuid4())})
    with pytest.raises(MemoryContextUnavailable):
        if operation == 'entry':
            guard._enter_resume({})
        elif operation == 'execution':
            guard.resolve_child_execution(child_context_id=str(uuid4()), child_run_id=str(uuid4()))
        elif operation == 'source':
            guard.resume_binding = object()
            guard._check_source()
        else:
            guard.admit_child_execution_checkpoint(execution=SimpleNamespace(), state={})


@pytest.mark.parametrize('asynchronous', [False, True])
@pytest.mark.parametrize('fault', [None, 'binding', 'wrong-run', 'unknown-status', 'outage'])
def test_governed_list_uses_bound_live_status_not_cached_text(monkeypatch, asynchronous, fault):
    child, run = str(uuid4()), str(uuid4())
    native, sync_calls, async_calls = _make_native_list_tool()
    runtime = _runtime({child: {'task_id': child, 'thread_id': child, 'run_id': run,
        'agent_name': 'sophia_builder', 'status': 'success', 'result': 'SYNTHETIC PRIVATE CACHE'}})
    binding = SimpleNamespace(child_run_id=run)
    def resolve(**kwargs):
        assert kwargs == {'child_context_id': child, 'child_run_id': run}
        if fault == 'binding': raise RuntimeError('synthetic binding unavailable')
        return binding
    guard = SimpleNamespace(check=lambda: None, resolve_child_association=resolve)
    monkeypatch.setattr('deerflow.agents.sophia_agent.middlewares.memory_context.active_governed_tool_guard', lambda: guard)
    def get(**kwargs):
        assert kwargs == {'thread_id': child, 'run_id': run}
        if fault == 'outage': raise RuntimeError('synthetic native outage')
        return {'thread_id': child, 'run_id': str(uuid4()) if fault == 'wrong-run' else run,
            'status': 'unknown' if fault == 'unknown-status' else 'running', 'result': 'MUST NOT RETURN'}
    async def aget(**kwargs): return get(**kwargs)
    clients = SimpleNamespace(get_sync=lambda _: SimpleNamespace(runs=SimpleNamespace(get=get)),
        get_async=lambda _: SimpleNamespace(runs=SimpleNamespace(get=aget)))
    monkeypatch.setattr(wrapper, '_native_clients', lambda _: clients)
    tool = wrapper.make_list_async_tasks_wrapper(native)
    raw = asyncio.run(tool.coroutine(runtime=runtime, status_filter='running')) if asynchronous else tool.func(runtime=runtime, status_filter='running')
    result = json.loads(raw)
    assert result['availability'] == ('unavailable' if fault else 'available')
    assert 'PRIVATE' not in raw and 'MUST NOT RETURN' not in raw
    assert not sync_calls and not async_calls
    assert runtime.state['async_tasks'][child]['status'] == 'success'
    if not fault:
        assert result['tasks'][0]['native_status'] == 'running'
        assert result['tasks'][0]['result_availability'] == 'not_read'
        assert result['lifecycle_mutated'] is False
    else:
        assert result['tasks'] == [] and result['enumeration_complete'] is False


@pytest.mark.parametrize('asynchronous', [False, True])
@pytest.mark.parametrize('fault', [None, 'revoked', 'binding-changed', 'inventory-changed'])
def test_installed_native_list_closure_and_post_read_fences(monkeypatch, asynchronous, fault):
    from deepagents.middleware.async_subagents import _build_list_tasks_tool

    child, run = str(uuid4()), str(uuid4())
    runtime = _runtime({child: {'task_id': child, 'thread_id': child, 'run_id': run,
        'agent_name': 'sophia_builder', 'status': 'success', 'result': 'PRIVATE CACHE'}})
    observed = []
    binding = SimpleNamespace(child_run_id=run)

    def check():
        if observed and fault == 'revoked':
            raise RuntimeError('synthetic authority revoked during native read')

    def resolve(**kwargs):
        assert kwargs == {'child_context_id': child, 'child_run_id': run}
        if observed and fault == 'binding-changed':
            return SimpleNamespace(child_run_id=str(uuid4()))
        return binding

    def get(**kwargs):
        assert kwargs == {'thread_id': child, 'run_id': run}
        observed.append(kwargs)
        if fault == 'inventory-changed':
            runtime.state['async_tasks'].clear()
        return {'thread_id': child, 'run_id': run, 'status': 'running', 'result': 'PRIVATE PROVIDER'}

    async def aget(**kwargs):
        return get(**kwargs)

    clients = SimpleNamespace(get_sync=lambda _: SimpleNamespace(runs=SimpleNamespace(get=get)),
        get_async=lambda _: SimpleNamespace(runs=SimpleNamespace(get=aget)))
    # Build the installed DeepAgents tool, not our synthetic native-tool fixture.
    # Keep _native_clients real: a dependency closure change must fail this test.
    native = _build_list_tasks_tool(clients)
    assert wrapper._native_clients(native.func) is clients
    assert wrapper._native_clients(native.coroutine) is clients
    monkeypatch.setattr('deerflow.agents.sophia_agent.middlewares.memory_context.active_governed_tool_guard',
        lambda: SimpleNamespace(check=check, resolve_child_association=resolve))
    tool = wrapper.make_list_async_tasks_wrapper(native)
    raw = asyncio.run(tool.coroutine(runtime=runtime, status_filter='running')) if asynchronous else tool.func(runtime=runtime, status_filter='running')
    result = json.loads(raw)
    assert len(observed) == 1
    assert 'PRIVATE' not in raw
    assert result['availability'] == ('unavailable' if fault else 'available')
    assert result['enumeration_complete'] is (fault is None)
    assert len(result['tasks']) == (0 if fault else 1)


@pytest.mark.parametrize('asynchronous', [False, True])
@pytest.mark.parametrize('fault', [None, 'binding', 'checkpoint', 'revoked', 'wrong-run', 'wrong-thread', 'outage', 'binding-changed'])
def test_installed_check_requires_live_binding_and_checkpoint(monkeypatch, asynchronous, fault):
    from deepagents.middleware.async_subagents import _build_check_tool
    from langgraph.types import Command

    child, run = str(uuid4()), str(uuid4())
    runtime = _runtime({child: {'task_id': child, 'thread_id': child, 'run_id': run,
        'agent_name': 'sophia_builder', 'status': 'success', 'result': 'PRIVATE CACHE'}})
    reads, admitted = [], []
    binding = SimpleNamespace(child_run_id=run)
    def resolve(**kwargs):
        assert kwargs == {'child_context_id': child, 'child_run_id': run}
        if fault == 'binding': raise RuntimeError('binding unavailable')
        if admitted and fault == 'binding-changed': return SimpleNamespace(child_run_id=str(uuid4()))
        return binding
    def check():
        if admitted and fault == 'revoked': raise RuntimeError('revoked')
    state = {'messages': [], 'builder_result': {'status': 'completed', 'terminal_status': 'completed',
        'artifact_path': '/mnt/user-data/outputs/synthetic-table.md', 'summary': 'ADMITTED SYNTHETIC RESULT'}}
    def admit(**kwargs):
        assert kwargs == {'child_context_id': child, 'child_run_id': run, 'state': state}
        admitted.append(True)
        if fault == 'checkpoint': raise RuntimeError('checkpoint unavailable')
    def get_run(**kwargs):
        reads.append('run')
        if fault == 'outage': raise RuntimeError('PRIVATE PROVIDER ERROR')
        return {'thread_id': child, 'run_id': str(uuid4()) if fault == 'wrong-run' else run, 'status': 'success'}
    def get_thread(**kwargs):
        reads.append('thread')
        return {'thread_id': str(uuid4()) if fault == 'wrong-thread' else child, 'values': state}
    async def aget_run(**kwargs): return get_run(**kwargs)
    async def aget_thread(**kwargs): return get_thread(**kwargs)
    clients = SimpleNamespace(
        get_sync=lambda _: SimpleNamespace(runs=SimpleNamespace(get=get_run), threads=SimpleNamespace(get=get_thread)),
        get_async=lambda _: SimpleNamespace(runs=SimpleNamespace(get=aget_run), threads=SimpleNamespace(get=aget_thread)))
    monkeypatch.setattr('deerflow.agents.sophia_agent.middlewares.memory_context.active_governed_tool_guard',
        lambda: SimpleNamespace(check=check, resolve_child_association=resolve, admit_child_checkpoint=admit))
    tool = wrapper.make_check_async_task_wrapper(_build_check_tool(clients))
    result = asyncio.run(tool.coroutine(task_id=child, runtime=runtime)) if asynchronous else tool.func(task_id=child, runtime=runtime)
    assert 'PRIVATE CACHE' not in str(result)
    assert 'PRIVATE PROVIDER ERROR' not in str(result)
    if fault:
        assert not isinstance(result, Command)
        assert json.loads(result)['availability'] == 'unavailable'
        assert 'ADMITTED SYNTHETIC RESULT' not in str(result)
    else:
        assert reads == ['run', 'thread'] and admitted == [True]
        assert isinstance(result, Command)
        payload = json.loads(result.update['messages'][0].content)
        assert payload['status'] == 'success'
        assert payload['summary'] == 'ADMITTED SYNTHETIC RESULT'
        assert payload['artifact_path'] == '/mnt/user-data/outputs/synthetic-table.md'
    assert runtime.state['async_tasks'][child]['result'] == 'PRIVATE CACHE'


@pytest.mark.parametrize('fault', [None, 'tampered-result', 'wrong-parent', 'source-outage'])
def test_check_composes_real_guard_binding_and_checkpoint(source, monkeypatch, fault):
    from deepagents.middleware.async_subagents import _build_check_tool
    from langgraph.types import Command
    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryRunGuard
    from deerflow.sophia.memory_governance.builder_provenance import issue_builder_handoff, bind_builder_run
    from deerflow.sophia.memory_governance.context_provenance import CHECKPOINT_PROOF_KEY, seal_checkpoint
    from deerflow.sophia.memory_governance.input_provenance import INPUT_PROOF_KEY, INPUT_RUN_KEY
    from deerflow.sophia.memory_governance.retained_admission import RetainedAdmission
    from deerflow.sophia.memory_governance.retained_context import ContextTransition

    monkeypatch.setattr('deerflow.sophia.memory_governance.owner_authority.resolve_owner_authority',
        lambda owner, **kwargs: SimpleNamespace(user_id=owner, authority_state='governed'))
    for name in ('CANDIDATE_LEDGER_WRITE', 'CANDIDATE_LEDGER_READ', 'CANONICAL_POOL_READ', 'PROVIDER_PROJECTION', 'GOVERNED_RUNTIME_READ'):
        monkeypatch.setenv('SOPHIA_MEMORY_' + name, 'true')
    monkeypatch.setenv('SOPHIA_MEMORY_COHORT_PRINCIPALS', 'owner')
    monkeypatch.setattr('deerflow.sophia.memory_governance.store.configured_memory_store', lambda: source['store'])
    source['store'].get_user_governance = lambda owner: SimpleNamespace(user_id=owner, user_revocation_epoch=0, user_catalog_generation=3)
    # Canonical admission is the explicit seam; source checks, original binding,
    # whole-checkpoint seal and guard union are the real implementation.
    monkeypatch.setattr(MemoryRunGuard, '_readmit', lambda self, context: RetainedAdmission(
        ContextTransition('continue', 'empty', 0), context, (), uuid4()))
    monkeypatch.setattr(MemoryRunGuard, '_empty_native_surface', lambda self: None)
    guard = MemoryRunGuard(owner_id='owner', scope='life', config={'thread_id': source['thread_id'], 'langgraph_auth_user_id': 'owner',
        INPUT_PROOF_KEY: source['input_proof'], INPUT_RUN_KEY: source['run_id']})
    guard.enter({'messages': source['messages']})
    monkeypatch.setattr('deerflow.agents.sophia_agent.middlewares.memory_context.active_builder_parent_guard',
        lambda owner, thread: guard if (owner, thread) == ('owner', source['thread_id']) else None)
    child, run = str(uuid4()), str(uuid4())
    wire, proof = issue_builder_handoff(guard=guard, owner_id='owner', parent_thread_id=source['thread_id'],
        child_thread_id=child, source_messages=source['messages'])
    bound, _ = bind_builder_run(owner_id='owner', child_thread_id=child, run_id=run, wire_input=wire, proof=proof)
    from langchain_core.messages import convert_to_messages
    bound['messages'] = convert_to_messages(bound['messages'])
    state = {**bound, 'delegation_context': {'parent_user_id': 'owner',
        'parent_thread_id': str(uuid4()) if fault == 'wrong-parent' else source['thread_id']},
        'builder_result': {'status': 'completed', 'terminal_status': 'completed',
            'artifact_path': '/mnt/user-data/outputs/synthetic.md', 'summary': 'SEALED SYNTHETIC RESULT'}}
    state[CHECKPOINT_PROOF_KEY] = seal_checkpoint(owner_id='owner', context_id=child, run_id=run,
        state=state, admission=guard.admission, source_dependencies=guard.source_dependencies)
    if fault == 'tampered-result': state['builder_result']['summary'] = 'TAMPERED SYNTHETIC RESULT'
    if fault == 'source-outage': source['store'].unavailable = True
    async def get_run(**kwargs): return {'thread_id': child, 'run_id': run, 'status': 'success'}
    async def get_thread(**kwargs): return {'thread_id': child, 'values': state}
    clients = SimpleNamespace(get_async=lambda _: SimpleNamespace(runs=SimpleNamespace(get=get_run),
        threads=SimpleNamespace(get=get_thread)))
    monkeypatch.setattr('deerflow.agents.sophia_agent.middlewares.memory_context.active_governed_tool_guard', lambda: guard)
    runtime = _runtime({child: {'task_id': child, 'thread_id': child, 'run_id': run,
        'agent_name': 'sophia_builder', 'status': 'success', 'result': 'PRIVATE CACHE'}})
    tool = wrapper.make_check_async_task_wrapper(_build_check_tool(clients))
    result = asyncio.run(tool.coroutine(task_id=child, runtime=runtime))
    if fault:
        assert not isinstance(result, Command)
        assert json.loads(result)['availability'] == 'unavailable'
        assert 'SYNTHETIC RESULT' not in str(result)
    else:
        assert isinstance(result, Command)
        assert json.loads(result.update['messages'][0].content)['summary'] == 'SEALED SYNTHETIC RESULT'
    assert 'PRIVATE CACHE' not in str(result)
