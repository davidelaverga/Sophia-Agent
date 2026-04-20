from types import SimpleNamespace

from deerflow.agents.middlewares.thread_data_middleware import ThreadDataMiddleware


def test_before_agent_uses_configurable_thread_id_when_context_missing(tmp_path):
    middleware = ThreadDataMiddleware(base_dir=str(tmp_path), lazy_init=True)
    runtime = SimpleNamespace(context={}, config={"configurable": {"thread_id": "thread-from-config"}})

    result = middleware.before_agent({}, runtime)

    assert result == {
        "thread_data": {
            "workspace_path": str(tmp_path / "threads" / "thread-from-config" / "user-data" / "workspace"),
            "uploads_path": str(tmp_path / "threads" / "thread-from-config" / "user-data" / "uploads"),
            "outputs_path": str(tmp_path / "threads" / "thread-from-config" / "user-data" / "outputs"),
        }
    }
    assert runtime.context["thread_id"] == "thread-from-config"