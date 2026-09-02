import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAuthenticatedUserIdMock = vi.fn()
const getUserScopedAuthTokenMock = vi.fn()
const getUserScopedAuthHeaderMock = vi.fn()
const resolveSophiaUserIdMock = vi.fn()
const fetchSophiaApiMock = vi.fn()

vi.mock('../../app/lib/auth/server-auth', () => ({
  getAuthenticatedUserId: (...args: unknown[]) => getAuthenticatedUserIdMock(...args),
  getUserScopedAuthToken: (...args: unknown[]) => getUserScopedAuthTokenMock(...args),
  getUserScopedAuthHeader: (...args: unknown[]) => getUserScopedAuthHeaderMock(...args),
  refreshUserScopedAuthHeader: vi.fn(),
}))

vi.mock('../../app/api/_lib/sophia', () => ({
  resolveSophiaUserId: (...args: unknown[]) => resolveSophiaUserIdMock(...args),
  fetchSophiaApi: (...args: unknown[]) => fetchSophiaApiMock(...args),
}))

import { POST as postConsent } from '../../app/api/privacy/consent/route'
import { DELETE as deletePrivacy } from '../../app/api/privacy/delete/route'
import { GET as exportPrivacy } from '../../app/api/privacy/export/route'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('privacy routes auth and MEM00 truthfulness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.BACKEND_API_URL = 'http://backend.test'
    getAuthenticatedUserIdMock.mockResolvedValue('user-123')
    getUserScopedAuthTokenMock.mockResolvedValue('token-123')
    getUserScopedAuthHeaderMock.mockResolvedValue('Bearer token-123')
    resolveSophiaUserIdMock.mockResolvedValue('user-123')
    fetchSophiaApiMock.mockResolvedValue(jsonResponse({
      memories: [],
      source: 'sophia_canonical',
    }))
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true })) as unknown as typeof fetch
  })

  it('rejects export when the user is not authenticated', async () => {
    resolveSophiaUserIdMock.mockResolvedValue(null)

    const response = await exportPrivacy(new Request('http://localhost:3000/api/privacy/export') as never)

    expect(response.status).toBe(401)
    expect(fetchSophiaApiMock).not.toHaveBeenCalled()
  })

  it('exports active, forgotten, and pending data from the canonical authority', async () => {
    fetchSophiaApiMock
      .mockResolvedValueOnce(jsonResponse({ memories: [{ id: 'active-1' }], source: 'sophia_canonical' }))
      .mockResolvedValueOnce(jsonResponse({ memories: [{ id: 'forgotten-1' }], source: 'sophia_canonical' }))
      .mockResolvedValueOnce(jsonResponse({ memories: [{ id: 'candidate-1' }], source: 'sophia_candidate_ledger' }))

    const response = await exportPrivacy(new Request('http://localhost:3000/api/privacy/export') as never)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(payload.scope).toBe('memory_only')
    expect(payload.metadata).toMatchObject({
      authority: 'sophia_canonical',
      source_transcripts_included: false,
      other_account_data_included: false,
    })
    expect(payload.data.memories.map((memory: { id: string }) => memory.id)).toEqual([
      'active-1',
      'forgotten-1',
      'candidate-1',
    ])
    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(3)
  })

  it('does not turn an unavailable export authority into an empty successful export', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(jsonResponse({ error: 'missing' }, 404))

    const response = await exportPrivacy(new Request('http://localhost:3000/api/privacy/export') as never)

    expect(response.status).toBe(501)
    await expect(response.json()).resolves.toMatchObject({ status: 'unsupported' })
  })

  it('rejects delete when the user-scoped authorization header is missing', async () => {
    getUserScopedAuthHeaderMock.mockResolvedValue('')

    const response = await deletePrivacy(new Request('http://localhost:3000/api/privacy/delete', { method: 'DELETE' }) as never)

    expect(response.status).toBe(401)
    expect(fetchSophiaApiMock).not.toHaveBeenCalled()
  })

  it('fences each canonical memory before reporting provider purge state', async () => {
    fetchSophiaApiMock
      .mockResolvedValueOnce(jsonResponse({
        source: 'sophia_canonical',
        memories: [{ id: '11111111-1111-4111-8111-111111111111', metadata: { memory_governance_revision: 4 } }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        source: 'sophia_canonical',
        memories: [{ id: '22222222-2222-4222-8222-222222222222', metadata: { memory_governance_revision: 7 } }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        source: 'sophia_candidate_ledger',
        memories: [{ id: '33333333-3333-4333-8333-333333333333', metadata: { candidate_revision: 2 } }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        results: [{ id: '33333333-3333-4333-8333-333333333333', action: 'discard', status: 'ok' }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'accepted_and_fenced',
        canonical_memory_fence: 'committed',
        provider_purge: 'purge_pending',
      }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'accepted_and_fenced',
        canonical_memory_fence: 'committed',
        provider_purge: 'purge_pending',
      }))

    const response = await deletePrivacy(new Request('http://localhost:3000/api/privacy/delete', { method: 'DELETE' }) as never)
    const payload = await response.json()

    expect(response.status).toBe(202)
    expect(payload).toMatchObject({
      status: 'accepted_and_fenced',
      canonical_memory_fence: 'committed',
      provider_purge: 'purge_pending',
      source_transcript: 'not_deleted',
      other_account_data: 'not_covered_by_mem00',
      memory_count: 2,
      fenced_count: 2,
      failed_count: 0,
      pending_candidate_count: 1,
      rejected_candidate_count: 1,
    })
    expect(fetchSophiaApiMock).toHaveBeenNthCalledWith(
      4,
      '/api/sophia/user-123/memories/bulk-review',
      {
        method: 'POST',
        body: JSON.stringify({
          items: [{
            id: '33333333-3333-4333-8333-333333333333',
            action: 'discard',
            expected_candidate_revision: 2,
            idempotency_key: 'privacy-clear-candidate:33333333-3333-4333-8333-333333333333:2',
          }],
        }),
      },
    )
    expect(fetchSophiaApiMock).toHaveBeenNthCalledWith(
      5,
      '/api/sophia/user-123/memories/11111111-1111-4111-8111-111111111111/permanent-delete',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          expected_governance_revision: 4,
          idempotency_key: 'privacy-clear:11111111-1111-4111-8111-111111111111:4',
        }),
      }),
    )
  })

  it('reports a canonical fencing failure as partial rather than success', async () => {
    fetchSophiaApiMock
      .mockResolvedValueOnce(jsonResponse({
        source: 'sophia_canonical',
        memories: [{ id: '11111111-1111-4111-8111-111111111111', metadata: { memory_governance_revision: 4 } }],
      }))
      .mockResolvedValueOnce(jsonResponse({ source: 'sophia_canonical', memories: [] }))
      .mockResolvedValueOnce(jsonResponse({ source: 'sophia_candidate_ledger', memories: [] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'conflict' }, 409))

    const response = await deletePrivacy(new Request('http://localhost:3000/api/privacy/delete', { method: 'DELETE' }) as never)

    expect(response.status).toBe(207)
    await expect(response.json()).resolves.toMatchObject({
      status: 'partial_failure',
      canonical_memory_fence: 'partial',
      fenced_count: 0,
      failed_count: 1,
    })
  })

  it('never treats a legacy upstream 404 as successful deletion', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(jsonResponse({ memories: [], source: 'mem0' }))
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'missing' }, 404)) as unknown as typeof fetch

    const response = await deletePrivacy(new Request('http://localhost:3000/api/privacy/delete', { method: 'DELETE' }) as never)
    const payload = await response.json()

    expect(response.status).toBe(501)
    expect(payload).toMatchObject({
      status: 'unsupported',
      canonical_memory_fence: 'unsupported_legacy_contract',
      provider_purge: 'route_missing_not_success',
    })
  })

  it('uses the user-scoped token for consent submission', async () => {
    await postConsent(new Request('http://localhost:3000/api/privacy/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept: true }),
    }) as never)

    expect(global.fetch).toHaveBeenCalledWith(
      'http://backend.test/api/privacy/consent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token-123' }),
      }),
    )
  })
})
