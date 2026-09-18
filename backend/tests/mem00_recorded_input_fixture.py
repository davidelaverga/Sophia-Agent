"""Explicit synthetic source authority for non-SQL auth/runtime unit tests.

No autouse bypass: callers opt into a complete source receipt/snapshot fixture.
The separate composed instrument supplies actual PostgreSQL-backed reads.
"""

from copy import deepcopy
from uuid import uuid4

from deerflow.sophia.memory_governance.refs import keyed_ref
from deerflow.sophia.session_store import SessionMessageRecord, _storage_message_row_id


class RecordedInputFixture:
    def __init__(self):
        self.receipts = {}
        self.clear_epoch = 0
        self.unavailable = False
        self.versions = {}
        self.builder_handoffs = {}
        self.builder_bindings = {}
        self.builder_resume_bindings = {}
        self.completion_bindings = {}
        self.completion_activations = {}

    def get_completion_activation(self, **kwargs):
        if self.unavailable:
            raise RuntimeError("SYNTHETIC ACTIVATION LOOKUP OUTAGE")
        return deepcopy(self.completion_activations.get(tuple(sorted(kwargs.items()))))

    def bind_completion_activation(self, *, p_completion_run_id, p_recovery_key, **kwargs):
        from deerflow.sophia.memory_governance.builder_source_binding import BuilderSourceBindingService
        from deerflow.sophia.memory_governance.completion_activation import resolve_task_execution

        prior = self.get_completion_activation(**kwargs)
        if prior is not None:
            if prior["completion_run_id"] != p_completion_run_id:
                raise RuntimeError("SYNTHETIC ACTIVATION CONFLICT")
            return prior
        owner = kwargs["p_user_id"]
        target = {key.removeprefix("p_"): value for key, value in kwargs.items() if key != "p_user_id"}
        original = BuilderSourceBindingService(owner_id=owner, store=self).resolve_child(
            parent_thread_id=target["parent_thread_id"], child_thread_id=target["child_thread_id"], child_run_id=target["original_child_run_id"])
        selected = resolve_task_execution(owner=owner, parent_thread_id=target["parent_thread_id"],
            child_thread_id=target["child_thread_id"], original_run_id=target["original_child_run_id"], store=self)
        if selected.run_id != target["selected_child_run_id"] or p_completion_run_id in (original.parent_run_id, original.child_run_id, selected.run_id):
            raise RuntimeError("SYNTHETIC ACTIVATION ORIGIN CONFLICT")
        receipt = {"schema": "mem00.completion-activation.v1", "binding_event_id": str(uuid4()), "owner_id": owner,
            "target": target, "canonical_recovery_key": p_recovery_key, "completion_run_id": p_completion_run_id, "child_binding_event_id": original.binding_event_id,
            "child_resume_binding_event_id": selected.resume_binding_event_id, "memory_clear_epoch": self.clear_epoch,
            "accepted_at": "2026-09-12T00:00:00Z", "historical_result_only": True, "model_permission": False}
        self.completion_activations[tuple(sorted(kwargs.items()))] = receipt
        return deepcopy(receipt)

    def get_builder_resume_run(self, *, p_user_id, p_recovery_key):
        if self.unavailable:
            raise RuntimeError("SYNTHETIC RESUME LOOKUP OUTAGE")
        return deepcopy(self.builder_resume_bindings.get((p_user_id, p_recovery_key)))

    def record(self, owner, thread, content, session=None):
        session = session or str(uuid4())
        action = {"thread_id": thread, "message_id": str(uuid4()), "command_key": str(uuid4()),
            "expected_clear_epoch": self.clear_epoch, "content": content}
        row_id = _storage_message_row_id(SessionMessageRecord(session_id=session, thread_id=thread, message_id=action["message_id"], role="user", content=content))
        version = str(uuid4())
        receipt = {"schema": "mem00.source-action.v1", "owner_id": owner, "session_id": session, "thread_id": thread,
            "command_key": action["command_key"], "message_id": action["message_id"], "source_row_id": row_id, "source_version": version,
            "event_id": str(uuid4()), "sequence": len(self.receipts) + 1, "memory_clear_epoch": self.clear_epoch,
            "transcript_revision": len(self.receipts) + 1, "created_at": "2026-09-09T00:00:00Z",
            "content_ref": keyed_ref("source-action-content", content), "historical_result_only": True,
            "idempotent_replay": True, "status": "source_recorded", "memory_approval": "not_granted",
            "current_extraction_eligibility": "not_verified_in_this_response"}
        self.receipts[(owner, action["command_key"])] = receipt
        self.versions[action["message_id"]] = version
        return session, action

    def source_action_status(self, *, user_id, command_key):
        if self.unavailable:
            raise RuntimeError("SYNTHETIC SOURCE OUTAGE")
        receipt = self.receipts.get((user_id, command_key))
        return {"schema": "mem00.source-action-status.v1", "owner_id": user_id, "command_key": command_key,
            "historical_result_only": True, "status": "committed" if receipt else "not_found", "receipt": deepcopy(receipt)}

    def source_snapshot(self, *, user_id, session_id, thread_id):
        if self.unavailable:
            raise RuntimeError("SYNTHETIC SOURCE OUTAGE")
        rows = []
        for receipt in self.receipts.values():
            if (receipt["owner_id"], receipt["session_id"], receipt["thread_id"]) != (user_id, session_id, thread_id):
                continue
            message = receipt["message_id"]
            if message not in self.versions:
                continue
            version = self.versions[message]
            rows.append({"message_id": message, "sequence": receipt["sequence"], "source_version": version,
                "acceptance_epoch": receipt["memory_clear_epoch"], "accepted_version": receipt["source_version"] if receipt["memory_clear_epoch"] > 0 else None,
                "eligibility": "before_clear" if receipt["memory_clear_epoch"] < self.clear_epoch else
                    "eligible" if self.clear_epoch == 0 or version == receipt["source_version"] else "accepted_version_changed"})
        return {"schema": "mem00.source-snapshot.v1", "snapshot_id": "mem00-source-snapshot-" + "a" * 32,
            "owner_id": user_id, "session_id": session_id, "thread_id": thread_id, "transcript_revision": len(self.receipts),
            "memory_clear_epoch": self.clear_epoch, "context_mode": "life", "status": "active", "ended_at": None, "sources": rows}

    def register_builder_handoff(self, *, p_user_id, p_handoff):
        from deerflow.sophia.memory_governance.source_dependencies import recheck_source_dependencies

        key = (p_user_id, p_handoff["child_thread_id"])
        if key in self.builder_handoffs:
            receipt = self.builder_handoffs[key]
            if receipt["request"] != p_handoff:
                raise RuntimeError("synthetic handoff conflict")
            return deepcopy(receipt)
        recheck_source_dependencies(owner_id=p_user_id, values=p_handoff["source_dependencies"], store=self)
        receipt = {"schema": "mem00.builder-source-handoff-receipt.v1", "event_id": str(uuid4()), "owner_id": p_user_id,
            "child_thread_id": p_handoff["child_thread_id"], "request": deepcopy(p_handoff), "memory_clear_epoch": self.clear_epoch,
            "initial_memory_manifest": deepcopy(p_handoff["initial_memory_manifest"]), "accepted_at": "2026-09-09T00:00:00Z", "historical_result_only": True}
        self.builder_handoffs[key] = receipt
        return deepcopy(receipt)

    def get_builder_handoff(self, *, p_user_id, p_child_thread_id):
        return deepcopy(self.builder_handoffs.get((p_user_id, p_child_thread_id)))

    def bind_builder_source_run(self, *, p_user_id, p_handoff_event_id, p_child_thread_id, p_child_run_id, p_payload_ref):
        from deerflow.sophia.memory_governance.source_dependencies import recheck_source_dependencies

        handoff = self.get_builder_handoff(p_user_id=p_user_id, p_child_thread_id=p_child_thread_id)
        if handoff is None or handoff["event_id"] != p_handoff_event_id or handoff["request"]["payload_ref"] != p_payload_ref:
            raise RuntimeError("synthetic handoff mismatch")
        key = (p_user_id, p_handoff_event_id)
        if key in self.builder_bindings:
            receipt = self.builder_bindings[key]
            if receipt["child_run_id"] != p_child_run_id:
                raise RuntimeError("synthetic run already bound")
            return deepcopy(receipt)
        recheck_source_dependencies(owner_id=p_user_id, values=handoff["request"]["source_dependencies"], store=self)
        receipt = {"schema": "mem00.builder-source-run.v1", "binding_event_id": str(uuid4()), "handoff_event_id": p_handoff_event_id,
            "owner_id": p_user_id, "parent_thread_id": handoff["request"]["parent_thread_id"], "parent_run_id": handoff["request"]["parent_run_id"],
            "child_thread_id": p_child_thread_id, "child_run_id": p_child_run_id, "payload_ref": p_payload_ref,
            "source_dependencies": deepcopy(handoff["request"]["source_dependencies"]), "memory_clear_epoch": handoff["memory_clear_epoch"],
            "initial_memory_manifest": deepcopy(handoff["initial_memory_manifest"]), "accepted_at": "2026-09-09T00:00:00Z", "historical_result_only": True}
        self.builder_bindings[key] = receipt
        return deepcopy(receipt)

    def get_builder_source_run_for_handoff(self, *, p_user_id, p_handoff_event_id):
        return deepcopy(self.builder_bindings.get((p_user_id, p_handoff_event_id)))

    def get_builder_source_run(self, *, p_user_id, p_binding_event_id):
        if self.unavailable:
            raise RuntimeError("synthetic database unavailable")
        for (owner, _), value in self.builder_bindings.items():
            if owner == p_user_id and value["binding_event_id"] == p_binding_event_id:
                return deepcopy(value)
        return None

    def register_completion_source_run(self, *, p_user_id, p_completion):
        from deerflow.sophia.memory_governance.source_dependencies import recheck_source_dependencies
        if self.unavailable:
            raise RuntimeError("synthetic database unavailable")
        key = (p_user_id, p_completion["completion_run_id"])
        if key in self.completion_bindings:
            receipt = self.completion_bindings[key]
            if receipt["request"] != p_completion:
                raise RuntimeError("synthetic completion run conflict")
            return deepcopy(receipt)
        child = p_completion["child_binding"]
        if self.get_builder_source_run(p_user_id=p_user_id, p_binding_event_id=child["binding_event_id"]) != child:
            raise RuntimeError("synthetic child binding mismatch")
        recheck_source_dependencies(owner_id=p_user_id, values=p_completion["source_dependencies"], store=self)
        receipt = {"schema": "mem00.completion-source-run.v1", "binding_event_id": str(uuid4()), "owner_id": p_user_id,
            "completion_run_id": key[1], "request": deepcopy(p_completion), "memory_clear_epoch": self.clear_epoch,
            "accepted_at": "2026-09-09T00:00:00Z", "historical_result_only": True}
        self.completion_bindings[key] = receipt
        return deepcopy(receipt)

    def get_completion_source_run(self, *, p_user_id, p_completion_run_id):
        if self.unavailable:
            raise RuntimeError("synthetic database unavailable")
        return deepcopy(self.completion_bindings.get((p_user_id, p_completion_run_id)))
