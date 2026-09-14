import { type NextRequest, NextResponse } from 'next/server'

import { logger } from '../../lib/error-logger'
import { isSavedJournalEntry } from '../../lib/journal'
import { parseJournalEnvelope } from '../../lib/memory-pool-envelope'
import { fetchSophiaApi, resolveSophiaUserId } from '../_lib/sophia'

export const dynamic = 'force-dynamic'
export const revalidate = 0
const noStore = { 'Cache-Control': 'no-store' }

export async function GET(request: NextRequest) {
  try {
    const userId = await resolveSophiaUserId()
    if (!userId) {
      return NextResponse.json(
        { error: 'Unable to resolve user_id' },
        { status: 401, headers: noStore },
      )
    }

    const params = new URLSearchParams()
    const category = request.nextUrl.searchParams.get('category') || request.nextUrl.searchParams.get('type')
    const search = request.nextUrl.searchParams.get('search')
    const status = request.nextUrl.searchParams.get('status')
    const savedOnly = request.nextUrl.searchParams.get('savedOnly') !== 'false'

    if (category) {
      params.set('category', category)
    }

    if (search) {
      params.set('search', search)
    }

    if (status) {
      params.set('status', status)
    }

    const query = params.toString()
    const suffix = query ? `?${query}` : ''

    const backendResponse = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/journal${suffix}`,
      { method: 'GET', cache: 'no-store' },
    )

    if (!backendResponse.ok) {
      return NextResponse.json({ error: 'Journal unavailable' }, {
        status: [401, 403, 404].includes(backendResponse.status) ? backendResponse.status : 503,
        headers: noStore,
      })
    }
    const responseText = await backendResponse.text()
    if (new TextEncoder().encode(responseText).byteLength > 8 * 1024 * 1024) throw new Error('Journal response unavailable')

    const payload = parseJournalEnvelope(JSON.parse(responseText), userId, status === 'forgotten' ? 'forgotten' : 'active')
    if (payload.schema === 'mem00.pool.v1') {
      if (payload.filters.category !== (category || null) || payload.filters.search !== (search?.trim().toLowerCase() || null)) {
        throw new Error('Pool filter scope unavailable')
      }
      return NextResponse.json(payload, { headers: noStore })
    }
    let entries = payload.entries

    if (savedOnly && !status) {
      entries = entries.filter(isSavedJournalEntry)
    }

    return NextResponse.json({
      ...payload,
      entries,
      count: entries.length,
    }, { headers: noStore })
  } catch {
    logger.logError(new Error('Journal unavailable'), { component: 'api/journal', action: 'list_journal_entries' })
    return NextResponse.json(
      { error: 'Failed to fetch journal entries' },
      { status: 503, headers: noStore },
    )
  }
}
