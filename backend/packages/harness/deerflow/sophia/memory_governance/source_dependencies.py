"""Exact recorded source dependencies; references, never source text or consent.

Only verified checkpoint/handoff producers may propagate these references.
Parsing a client-supplied list cannot establish origin. Conflicting revisions
and bounded-cap exhaustion require recovery, never truncation or epoch refresh.
"""

from .source_attachment import SourceAttachment, check_source_attachment
from .source_input_provenance import SourceInputWitness, recheck_recorded_source
from .store import MemoryGovernanceUnavailable

MAX_SOURCE_DEPENDENCIES = 128
SourceDependency = SourceInputWitness | SourceAttachment


def _identity(item):
    if isinstance(item, SourceAttachment):
        return ("attachment", item.session_id, item.event_id)
    return ("transcript", item.session_id, item.source_row_id)


def _order(item):
    if isinstance(item, SourceAttachment):
        return (1, item.session_id, item.request.source_witness.sequence, item.event_id)
    return (0, item.session_id, item.sequence, item.source_row_id)


def source_dependencies(*, owner_id, values):
    try:
        if not isinstance(values, (list, tuple)) or not 1 <= len(values) <= MAX_SOURCE_DEPENDENCIES:
            raise ValueError("size")
        witnesses = []
        occurrences, receipts = set(), set()
        for value in values:
            # JSON serialization can coerce a mutated bool/float into an int;
            # validate the original Python values before wire serialization.
            raw = value.model_dump(mode="python", by_alias=True, warnings=False) if isinstance(value, (SourceInputWitness, SourceAttachment)) else value
            model = SourceAttachment if isinstance(raw, dict) and raw.get("schema") == "mem00.source-attachment.v1" else SourceInputWitness
            item = model.model_validate(raw)
            key = _identity(item)
            if item.owner_id != owner_id or key in occurrences or item.event_id in receipts:
                raise ValueError("scope_or_duplicate")
            occurrences.add(key)
            receipts.add(item.event_id)
            witnesses.append(item)
        if any(isinstance(item, SourceAttachment) and item.request.source_witness not in witnesses for item in witnesses):
            raise ValueError("attachment_source_missing")
        return tuple(sorted(witnesses, key=_order))
    except Exception:
        raise MemoryGovernanceUnavailable("memory_source_dependencies_unproven") from None


def merge_source_dependencies(*, owner_id, groups):
    merged = {}
    for group in groups:
        for item in source_dependencies(owner_id=owner_id, values=group):
            key = _identity(item)
            if key in merged and merged[key] != item:
                raise MemoryGovernanceUnavailable("memory_source_dependencies_conflict")
            merged[key] = item
    return source_dependencies(owner_id=owner_id, values=list(merged.values()))


def encode_source_dependencies(*, owner_id, values):
    return [item.model_dump(mode="json", by_alias=True) for item in source_dependencies(owner_id=owner_id, values=values)]


def recheck_source_dependencies(*, owner_id, values, store):
    for item in source_dependencies(owner_id=owner_id, values=values):
        if isinstance(item, SourceAttachment):
            check_source_attachment(owner_id=owner_id, attachment=item, current_source=None, allow_ended=False, store=store)
        else:
            recheck_recorded_source(witness=item, owner_id=owner_id, thread_id=item.thread_id, store=store)


def recheck_model_source_dependencies(*, owner_id, current_witness, values, store):
    """An exact fresh action may use preserved same-session older sources.

    No current action means no cross-clear exception (Builder/completion keep
    their existing strict binding). Never modify a witness or source epoch.
    """
    sources = source_dependencies(owner_id=owner_id, values=values)
    if current_witness is None:
        return recheck_source_dependencies(owner_id=owner_id, values=sources, store=store)
    root = SourceInputWitness.model_validate(current_witness.model_dump(mode="python", by_alias=True, warnings=False))
    if root not in sources or any(item.thread_id != root.thread_id or item.memory_clear_epoch > root.memory_clear_epoch
        or (item.memory_clear_epoch < root.memory_clear_epoch and item.session_id != root.session_id) for item in sources):
        raise MemoryGovernanceUnavailable("recorded_model_sources_unavailable")
    if not any(isinstance(item, SourceAttachment) for item in sources) and all(item.memory_clear_epoch == root.memory_clear_epoch for item in sources):
        return recheck_source_dependencies(owner_id=owner_id, values=sources, store=store)
    from .source_use import check_model_source_use
    return check_model_source_use(owner_id=owner_id, current_witness=root, sources=sources, store=store)
