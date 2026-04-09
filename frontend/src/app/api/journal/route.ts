import { type NextRequest, NextResponse } from 'next/server'

import { logger } from '../../lib/error-logger'
import { isSavedJournalEntry, type JournalEntry, type JournalResponse } from '../../lib/journal'
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

export async function GET(request: NextRequest) {
  try {
    const userId = await resolveSophiaUserId(request.nextUrl.searchParams.get('user_id'))
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

    return NextResponse.json({
      entries,
      count: entries.length,
    })
  } catch (error) {
    logger.logError(error, { component: 'api/journal', action: 'list_journal_entries' })
    return NextResponse.json(
      { error: 'Failed to fetch journal entries' },
      { status: 500 },
    )
  }
}