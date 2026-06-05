from __future__ import annotations

from types import SimpleNamespace

from deerflow.sandbox.middleware import SandboxMiddleware


class _Provider:
    def __init__(self) -> None:
        self.acquired: list[str] = []
        self.released: list[str] = []

    def acquire(self, thread_id: str) -> str:
        self.acquired.append(thread_id)
        return f"sandbox-{thread_id}"

    def release(self, sandbox_id: str) -> None:
        self.released.append(sandbox_id)


def test_after_agent_allows_missing_runtime_context(monkeypatch) -> None:
    provider = _Provider()
    monkeypatch.setattr("deerflow.sandbox.middleware.get_sandbox_provider", lambda: provider)

    middleware = SandboxMiddleware()
    runtime = SimpleNamespace(context=None)

    assert middleware.after_agent({}, runtime) is None
    assert provider.released == []


def test_after_agent_releases_sandbox_from_state(monkeypatch) -> None:
    provider = _Provider()
    monkeypatch.setattr("deerflow.sandbox.middleware.get_sandbox_provider", lambda: provider)

    middleware = SandboxMiddleware()
    runtime = SimpleNamespace(context=None)

    assert middleware.after_agent({"sandbox": {"sandbox_id": "state-sandbox"}}, runtime) is None
    assert provider.released == ["state-sandbox"]


def test_after_agent_releases_sandbox_from_context(monkeypatch) -> None:
    provider = _Provider()
    monkeypatch.setattr("deerflow.sandbox.middleware.get_sandbox_provider", lambda: provider)

    middleware = SandboxMiddleware()
    runtime = SimpleNamespace(context={"sandbox_id": "context-sandbox"})

    assert middleware.after_agent({}, runtime) is None
    assert provider.released == ["context-sandbox"]


def test_before_agent_eager_allows_missing_thread_id(monkeypatch) -> None:
    provider = _Provider()
    monkeypatch.setattr("deerflow.sandbox.middleware.get_sandbox_provider", lambda: provider)

    middleware = SandboxMiddleware(lazy_init=False)
    runtime = SimpleNamespace(context=None)

    assert middleware.before_agent({}, runtime) is None
    assert provider.acquired == []
