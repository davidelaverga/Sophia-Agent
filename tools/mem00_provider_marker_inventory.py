"""Read-only project marker inventory on the captured SDK endpoint.

Never indexes memory/text/content, writes provider state, or emits raw identifiers.
Completeness requires stable provider counts, unique IDs and an explicit empty page.
This certifies the supported entity domain, not provider backups or null-entity bugs.
"""

from datetime import datetime, timezone


def inventory(client, reference, *, certification_subject, max_pages=100, page_size=100):
    if not 1 <= max_pages <= 100 or not 1 <= page_size <= 100:
        raise ValueError("inventory_bound_invalid")
    if not certification_subject:
        raise ValueError("certification_subject_missing")
    started = datetime.now(timezone.utc).isoformat()
    seen = set()
    declared = None
    page_counts = []
    matches = []
    complete = False
    # Mem0 requires at least one entity. OR covers each supported entity kind.
    filters = {"OR": [{key: "*"} for key in ("user_id", "agent_id", "app_id", "run_id")]}
    for page in range(1, max_pages + 1):
        raw = client.get_all(filters=filters, page=page, page_size=page_size)
        if not isinstance(raw, dict) or not isinstance(raw.get("results"), list):
            raise ValueError("inventory_response_shape")
        count = raw.get("count")
        if type(count) is not int or count < 0 or (declared is not None and count != declared):
            raise ValueError("inventory_count_unstable")
        declared = count
        rows = raw["results"]
        if len(rows) > page_size:
            raise ValueError("inventory_page_bound")
        page_counts.append(len(rows))
        if not rows:
            if raw.get("next") or len(seen) != declared:
                raise ValueError("inventory_terminal_count_mismatch")
            complete = True
            break
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError("inventory_row_shape")
            identity = row.get("id")
            if not isinstance(identity, str) or not identity or identity in seen:
                raise ValueError("inventory_duplicate_or_missing_id")
            seen.add(identity)
            metadata = row.get("metadata")
            if metadata is None:
                metadata = {}
            if not isinstance(metadata, dict):
                raise ValueError("inventory_metadata_shape")
            # Inspect only IDs and known structural marker fields; never content.
            subject = row.get("user_id")
            namespace = metadata.get("provider_namespace")
            run = metadata.get("certification_run_id")
            known_subject = subject == certification_subject or namespace == certification_subject
            marked = any(isinstance(value, str) and "mem00" in value.lower() for value in (subject, namespace, run))
            if known_subject or marked:
                matches.append({
                    "provider_ref": reference("provider", identity),
                    "subject_ref": reference("provider-subject", subject) if isinstance(subject, str) else None,
                    "classification": "certification_subject" if known_subject else "unresolved_certification_marker",
                    "operation_ref": reference("projection-operation", metadata["projection_operation_id"]) if isinstance(metadata.get("projection_operation_id"), str) else None,
                })
    if not complete:
        raise ValueError("inventory_page_cap")
    return {
        "schema": "mem00.provider-marker-inventory.v1",
        "started_at": started,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "scope": "current_project_supported_entity_domain",
        "page_counts": page_counts,
        "provider_reported_count": declared,
        "distinct_records": len(seen),
        "pagination_complete": True,
        "transactionally_consistent": False,
        "matches": matches,
        "marker_rows": len(matches),
        "unknown_marker_rows": sum(row["classification"] == "unresolved_certification_marker" for row in matches),
        "content_inspected": False,
        "mutations": 0,
        "terminal_zero_certified": False,
    }
