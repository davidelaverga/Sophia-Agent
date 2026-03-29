---
status: pending
priority: p2
issue_id: "008"
tags: [code-review, performance, correctness]
dependencies: []
---

# Mem0 Client: Blocking Call + No Client Caching + Thread-Unsafe Cache

## Problem Statement

Three interrelated issues in mem0_client.py:
1. `client.search()` is synchronous, blocking the async event loop for 100-400ms
2. `_get_client()` creates a new MemoryClient on every cache miss
3. Module-level `_cache` dict is unbounded and not thread-safe

## Findings

- **Performance agent (P0):** Under 10+ concurrent sessions, event loop starvation causes unpredictable latency
- **Security agent (HIGH-1):** Unbounded cache growth causes memory exhaustion; iteration during invalidation not atomic
- **Correctness agent (MEDIUM):** Concurrent reads/writes can corrupt cache

**Location:** `backend/packages/harness/deerflow/sophia/mem0_client.py`

## Proposed Solutions

1. Cache MemoryClient at module level (trivial)
2. Replace _cache with `cachetools.TTLCache(maxsize=1024, ttl=60)` + threading.Lock (small)
3. Run search in ThreadPoolExecutor for async safety (medium)

## Acceptance Criteria

- [ ] MemoryClient is created once and reused
- [ ] Cache has maxsize limit and thread-safe operations
- [ ] Synchronous Mem0 calls don't block the event loop
- [ ] Tests for cache TTL, invalidation, and concurrent access
