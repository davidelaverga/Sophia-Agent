import importlib


def test_normalize_builder_request_rewrites_generic_demo_frontend_task():
    switch_module = importlib.import_module("deerflow.sophia.tools.switch_to_builder")

    task, task_type, demo_mode = switch_module._normalize_builder_request(
        task="Build a sample project so the user can see the feature working.",
        task_type="frontend",
        companion_artifact={
            "session_goal": "Testing builder mode",
            "takeaway": "User is in test/exploration mode for builder functionality",
        },
    )

    assert demo_mode is True
    assert task_type == "document"
    assert "builder-demo.md" in task
    assert "emit_builder_artifact" in task


def test_normalize_builder_request_rewrites_live_builder_working_prompt():
    switch_module = importlib.import_module("deerflow.sophia.tools.switch_to_builder")

    task, task_type, demo_mode = switch_module._normalize_builder_request(
        task="I just wanna see a quick draft. Make anything. I just wanna see a builder working.",
        task_type="frontend",
        companion_artifact={},
    )

    assert demo_mode is True
    assert task_type == "document"
    assert "builder-demo.md" in task


def test_normalize_builder_request_rewrites_research_smoke_test():
    switch_module = importlib.import_module("deerflow.sophia.tools.switch_to_builder")

    task, task_type, demo_mode = switch_module._normalize_builder_request(
        task="Test builder. Just draft anything so I can see builder work.",
        task_type="research",
        companion_artifact={},
    )

    assert demo_mode is True
    assert task_type == "document"
    assert "builder-demo.md" in task


def test_normalize_builder_request_preserves_specific_frontend_work():
    switch_module = importlib.import_module("deerflow.sophia.tools.switch_to_builder")

    task = "Create a landing page for Sofia with a hero, proof section, pricing cards, and FAQ."
    normalized_task, task_type, demo_mode = switch_module._normalize_builder_request(
        task=task,
        task_type="frontend",
        companion_artifact={
            "session_goal": "Ship a real frontend deliverable",
            "takeaway": "Need an actual landing page, not a demo flow",
        },
    )

    assert demo_mode is False
    assert task_type == "frontend"
    assert normalized_task == task


def test_normalize_builder_request_preserves_real_research_task():
    switch_module = importlib.import_module("deerflow.sophia.tools.switch_to_builder")

    task = "Research the current market size for remote patient monitoring and summarize the findings."
    normalized_task, task_type, demo_mode = switch_module._normalize_builder_request(
        task=task,
        task_type="research",
        companion_artifact={
            "session_goal": "Need a real research deliverable",
            "takeaway": "Research should be substantive, not a demo",
        },
    )

    assert demo_mode is False
    assert task_type == "research"
    assert normalized_task == task


def test_resolve_builder_limits_shortens_demo_budget():
    switch_module = importlib.import_module("deerflow.sophia.tools.switch_to_builder")

    assert switch_module._resolve_builder_limits(True) == (16, 45)
    assert switch_module._resolve_builder_limits(False) == (50, 120)