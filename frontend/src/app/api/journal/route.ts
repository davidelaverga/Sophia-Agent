import { type NextRequest, NextResponse } from 'next/server'

import { logger } from '../../lib/error-logger'
import { isFavoriteJournalEntry, isSavedJournalEntry, type JournalEntry, type JournalResponse } from '../../lib/journal'
import { fetchSophiaApi, resolveSophiaUserId } from '../_lib/sophia'

function normalizeEntry(entry: Partial<JournalEntry>): JournalEntry | null {
  if (typeof entry.id !== 'string' || entry.id.trim().length === 0) {
    return null
  }

  if (typeof entry.content !== 'string' || entry.content.trim().length === 0) {
    return null
  }

  return {
    id: entry.id,
    content: entry.content.trim(),
    category: typeof entry.category === 'string' ? entry.category : null,
    metadata: entry.metadata && typeof entry.metadata === 'object'
      ? entry.metadata
      : null,
    created_at: typeof entry.created_at === 'string' ? entry.created_at : null,
  }
}

function normalizePageNumber(value: string | null, min: number, max: number): number | null {
  if (!value) {
    return null
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed)) {
    return null
  }

  return Math.min(Math.max(parsed, min), max)
}

export async function GET(request: NextRequest) {
  try {
    const userId = await resolveSophiaUserId()
    if (!userId) {
      return NextResponse.json(
        { error: 'Unable to resolve user_id' },
        { status: 401 },
      )
    }

    const params = new URLSearchParams()
    const category = request.nextUrl.searchParams.get('category') || request.nextUrl.searchParams.get('type')
    const search = request.nextUrl.searchParams.get('search')
    const status = request.nextUrl.searchParams.get('status')
    const favorite = request.nextUrl.searchParams.get('favorite')
    const limit = normalizePageNumber(request.nextUrl.searchParams.get('limit'), 1, 100)
    const offset = normalizePageNumber(request.nextUrl.searchParams.get('offset'), 0, Number.MAX_SAFE_INTEGER)
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

    if (savedOnly && !status) {
      params.set('saved_only', 'true')
    }

    if (favorite === 'true') {
      params.set('favorite', 'true')
    }

    if (limit !== null) {
      params.set('limit', String(limit))
    }

    if (offset !== null) {
      params.set('offset', String(offset))
    }

    const query = params.toString()
    const suffix = query ? `?${query}` : ''

    const backendResponse = await fetchSophiaApi(
      `/api/sophia/${encodeURIComponent(userId)}/journal${suffix}`,
      { method: 'GET' },
    )

    const responseText = await backendResponse.text()
    if (!backendResponse.ok) {
      return new NextResponse(responseText, {
        status: backendResponse.status,
        headers: {
          'Content-Type': backendResponse.headers.get('content-type') || 'application/json',
        },
      })
    }

    const payload = responseText
      ? (JSON.parse(responseText) as JournalResponse)
      : { entries: [], count: 0 }

    let entries = Array.isArray(payload.entries)
      ? payload.entries.map(normalizeEntry).filter((entry): entry is JournalEntry => entry !== null)
      : []

    if (savedOnly && !status) {
      entries = entries.filter(isSavedJournalEntry)
    }

    if (favorite === 'true') {
      entries = entries.filter(isFavoriteJournalEntry)
    }

    const upstreamTotal = typeof payload.total_count === 'number'
      ? payload.total_count
      : typeof payload.totalCount === 'number'
        ? payload.totalCount
        : entries.length
    const responseOffset = typeof payload.offset === 'number' ? payload.offset : offset ?? 0
    const responseLimit = typeof payload.limit === 'number' ? payload.limit : limit
    const nextOffset = typeof payload.next_offset === 'number'
      ? payload.next_offset
      : typeof payload.nextOffset === 'number'
        ? payload.nextOffset
        : null
    const hasMore = typeof payload.has_more === 'boolean'
      ? payload.has_more
      : typeof payload.hasMore === 'boolean'
        ? payload.hasMore
        : nextOffset !== null && nextOffset < upstreamTotal

    return NextResponse.json({
      entries,
      count: entries.length,
      total_count: upstreamTotal,
      totalCount: upstreamTotal,
      limit: responseLimit,
      offset: responseOffset,
      next_offset: hasMore ? nextOffset : null,
      nextOffset: hasMore ? nextOffset : null,
      has_more: hasMore,
      hasMore,
    })
  } catch (error) {
    logger.logError(error, { component: 'api/journal', action: 'list_journal_entries' })
    return NextResponse.json(
      { error: 'Failed to fetch journal entries' },
      { status: 500 },
    )
  }
}
