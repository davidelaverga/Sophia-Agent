from types import SimpleNamespace

from deerflow.sandbox import tools


class _DummySandbox:
    def __init__(self) -> None:
        self.files: dict[str, str] = {}

    def write_file(self, path: str, content: str, append: bool = False) -> None:
        if append and path in self.files:
            self.files[path] += content
            return
        self.files[path] = content

    def read_file(self, path: str) -> str:
        return self.files[path]

    def execute_command_with_metadata(self, command: str) -> tuple[str, dict[str, object]]:
        return f"ok:{command}", {"status": "completed", "command": command}


def _runtime() -> SimpleNamespace:
    return SimpleNamespace(context={"thread_id": "thread-123"})


def _thread_data() -> dict[str, str]:
    return {
        "workspace_path": "/tmp/workspace",
        "uploads_path": "/tmp/uploads",
        "outputs_path": "/tmp/outputs",
    }


def _thread_data_under(base) -> dict[str, str]:
    return {
        "workspace_path": str(base / "workspace"),
        "uploads_path": str(base / "uploads"),
        "outputs_path": str(base / "outputs"),
    }


class _Provider:
    def __init__(self, sandbox: _DummySandbox) -> None:
        self.sandbox = sandbox
        self.acquired: list[str] = []

    def acquire(self, thread_id: str) -> str:
        self.acquired.append(thread_id)
        return "local"

    def get(self, sandbox_id: str):
        return self.sandbox if sandbox_id == "local" else None


def test_write_file_tool_skips_mirror_when_disabled(monkeypatch) -> None:
    sandbox = _DummySandbox()
    runtime = _runtime()
    mirrored_paths: list[str] = []

    monkeypatch.setattr(tools, "ensure_sandbox_initialized", lambda _runtime: sandbox)
    monkeypatch.setattr(tools, "ensure_thread_directories_exist", lambda _runtime: None)
    monkeypatch.setattr(tools, "is_local_sandbox", lambda _runtime: True)
    monkeypatch.setattr(tools, "get_thread_data", lambda _runtime: _thread_data())
    monkeypatch.setattr(tools, "validate_local_tool_path", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(tools, "_resolve_and_validate_user_data_path", lambda path, _thread_data: path)
    monkeypatch.setattr(tools.supabase_mirror, "is_mirror_enabled", lambda: False)
    monkeypatch.setattr(tools.supabase_mirror, "maybe_mirror_file", lambda path, *_args: mirrored_paths.append(path))

    result = tools.write_file_tool.func(runtime=runtime, description="write", path="/tmp/outputs/a.txt", content="hello")

    assert result == "OK"
    assert sandbox.files["/tmp/outputs/a.txt"] == "hello"
    assert mirrored_paths == []


def test_write_file_tool_calls_mirror_when_enabled(monkeypatch) -> None:
    sandbox = _DummySandbox()
    runtime = _runtime()
    mirrored_paths: list[str] = []

    monkeypatch.setattr(tools, "ensure_sandbox_initialized", lambda _runtime: sandbox)
    monkeypatch.setattr(tools, "ensure_thread_directories_exist", lambda _runtime: None)
    monkeypatch.setattr(tools, "is_local_sandbox", lambda _runtime: True)
    monkeypatch.setattr(tools, "get_thread_data", lambda _runtime: _thread_data())
    monkeypatch.setattr(tools, "validate_local_tool_path", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(tools, "_resolve_and_validate_user_data_path", lambda path, _thread_data: path)
    monkeypatch.setattr(tools.supabase_mirror, "is_mirror_enabled", lambda: True)
    monkeypatch.setattr(tools.supabase_mirror, "maybe_mirror_file", lambda path, *_args: mirrored_paths.append(path))

    result = tools.write_file_tool.func(runtime=runtime, description="write", path="/tmp/outputs/a.txt", content="hello")

    assert result == "OK"
    assert mirrored_paths == ["/tmp/outputs/a.txt"]


def test_write_file_tool_reacquires_sandbox_with_config_thread_id_when_context_missing(
    monkeypatch,
    tmp_path,
) -> None:
    sandbox = _DummySandbox()
    provider = _Provider(sandbox)
    thread_data = _thread_data_under(tmp_path)
    runtime = SimpleNamespace(
        context=None,
        config={"configurable": {"thread_id": "thread-from-config"}},
        state={"thread_data": thread_data},
    )

    monkeypatch.setattr(tools, "get_sandbox_provider", lambda: provider)
    monkeypatch.setattr(tools.supabase_mirror, "is_mirror_enabled", lambda: False)

    result = tools.write_file_tool.func(
        runtime=runtime,
        description="write",
        path="/mnt/user-data/outputs/a.txt",
        content="hello",
    )

    resolved_path = str(tmp_path / "outputs" / "a.txt")
    assert result == "OK"
    assert provider.acquired == ["thread-from-config"]
    assert runtime.state["sandbox"] == {"sandbox_id": "local"}
    assert sandbox.files[resolved_path] == "hello"


def test_ensure_sandbox_initialized_uses_config_thread_id_when_context_missing(
    monkeypatch,
) -> None:
    sandbox = _DummySandbox()
    provider = _Provider(sandbox)
    runtime = SimpleNamespace(
        context=None,
        config={"configurable": {"thread_id": "thread-from-config"}},
        state={},
    )

    monkeypatch.setattr(tools, "get_sandbox_provider", lambda: provider)

    assert tools.ensure_sandbox_initialized(runtime) is sandbox
    assert provider.acquired == ["thread-from-config"]
    assert runtime.state["sandbox"] == {"sandbox_id": "local"}


def test_write_file_tool_reacquires_sandbox_with_empty_context_and_config_thread_id(
    monkeypatch,
    tmp_path,
) -> None:
    sandbox = _DummySandbox()
    provider = _Provider(sandbox)
    runtime = SimpleNamespace(
        context={},
        config={"configurable": {"thread_id": "thread-from-config"}},
        state={"thread_data": _thread_data_under(tmp_path)},
    )

    monkeypatch.setattr(tools, "get_sandbox_provider", lambda: provider)
    monkeypatch.setattr(tools.supabase_mirror, "is_mirror_enabled", lambda: False)

    result = tools.write_file_tool.func(
        runtime=runtime,
        description="write",
        path="/mnt/user-data/outputs/a.txt",
        content="hello",
    )

    assert result == "OK"
    assert provider.acquired == ["thread-from-config"]
    assert runtime.context == {"sandbox_id": "local"}


def test_str_replace_tool_invokes_mirror_path(monkeypatch) -> None:
    sandbox = _DummySandbox()
    runtime = _runtime()
    mirrored_paths: list[str] = []
    sandbox.files["/tmp/outputs/a.txt"] = "hello world"

    monkeypatch.setattr(tools, "ensure_sandbox_initialized", lambda _runtime: sandbox)
    monkeypatch.setattr(tools, "ensure_thread_directories_exist", lambda _runtime: None)
    monkeypatch.setattr(tools, "is_local_sandbox", lambda _runtime: True)
    monkeypatch.setattr(tools, "get_thread_data", lambda _runtime: _thread_data())
    monkeypatch.setattr(tools, "validate_local_tool_path", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(tools, "_resolve_and_validate_user_data_path", lambda path, _thread_data: path)
    monkeypatch.setattr(tools.supabase_mirror, "is_mirror_enabled", lambda: True)
    monkeypatch.setattr(tools.supabase_mirror, "maybe_mirror_file", lambda path, *_args: mirrored_paths.append(path))

    result = tools.str_replace_tool.func(
        runtime=runtime,
        description="replace",
        path="/tmp/outputs/a.txt",
        old_str="world",
        new_str="sophia",
    )

    assert result == "OK"
    assert sandbox.files["/tmp/outputs/a.txt"] == "hello sophia"
    assert mirrored_paths == ["/tmp/outputs/a.txt"]


def test_bash_tool_scans_outputs_for_mirror_after_command(monkeypatch) -> None:
    sandbox = _DummySandbox()
    runtime = _runtime()
    scanned: list[tuple[str, str]] = []

    monkeypatch.setattr(tools, "ensure_sandbox_initialized", lambda _runtime: sandbox)
    monkeypatch.setattr(tools, "ensure_thread_directories_exist", lambda _runtime: None)
    monkeypatch.setattr(tools, "is_local_sandbox", lambda _runtime: True)
    monkeypatch.setattr(tools, "get_thread_data", lambda _runtime: _thread_data())
    monkeypatch.setattr(tools, "validate_local_bash_command_paths", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(tools, "replace_virtual_paths_in_command", lambda command, _thread_data: command)
    monkeypatch.setattr(tools, "_record_shell_telemetry", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(tools, "mask_local_paths_in_output", lambda output, _thread_data: output)
    monkeypatch.setattr(tools.supabase_mirror, "is_mirror_enabled", lambda: True)
    monkeypatch.setattr(
        tools.supabase_mirror,
        "scan_and_mirror_outputs",
        lambda thread_id, outputs_host_path: scanned.append((thread_id, outputs_host_path)),
    )

    result = tools.bash_tool.func(runtime=runtime, description="run", command="echo ok")

    assert result == "ok:echo ok"
    assert scanned == [("thread-123", "/tmp/outputs")]
