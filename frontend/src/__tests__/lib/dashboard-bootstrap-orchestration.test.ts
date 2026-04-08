import { describe, expect, it, vi } from 'vitest';

import { resolveDashboardBootstrapState } from '../../app/lib/dashboard-bootstrap-orchestration';

describe('resolveDashboardBootstrapState', () => {
  it('prioritizes backend resume when active session exists and no recent end hint', async () => {
    const checkActiveSession = vi.fn().mockResolvedValue({
      has_active_session: true,
      session: {
        session_id: 'sess-1',
        thread_id: 'thread-1',
        session_type: 'prepare',
        preset_context: 'gaming',
        status: 'active',
        started_at: new Date().toISOString(),
        turn_count: 3,
      },
    });
    const fetchBootstrapOpener = vi.fn();

    const result = await resolveDashboardBootstrapState({
      hasLocalActiveSession: false,
      hasRecentSessionEndHint: false,
      checkActiveSession,
      fetchBootstrapOpener,
      sleep: async () => undefined,
    });

    expect(result.mode).toBe('resume-backend');
    expect(checkActiveSession).toHaveBeenCalledTimes(1);
    expect(checkActiveSession).toHaveBeenCalledWith(false);
    expect(fetchBootstrapOpener).not.toHaveBeenCalled();
  });

  it('retries active checks for recent end and then shows opener when backend becomes inactive', async () => {
    const checkActiveSession = vi
      .fn()
      .mockResolvedValueOnce({
        has_active_session: true,
        session: {
          session_id: 'sess-stale-1',
          thread_id: 'thread-stale-1',
          session_type: 'prepare',
          preset_context: 'gaming',
          status: 'active',
          started_at: new Date().toISOString(),
          turn_count: 2,
        },
      })
      .mockResolvedValueOnce({
        has_active_session: true,
        session: {
          session_id: 'sess-stale-2',
          thread_id: 'thread-stale-2',
          session_type: 'prepare',
          preset_context: 'gaming',
          status: 'active',
          started_at: new Date().toISOString(),
          turn_count: 2,
        },
      })
      .mockResolvedValueOnce({ has_active_session: false });

    const fetchBootstrapOpener = vi.fn().mockResolvedValue({
      success: true,
      data: {
        opener_text: 'Welcome back. Ready to build momentum?',
        suggested_ritual: 'prepare',
        emotional_context: null,
        has_opener: true,
      },
    });

    const result = await resolveDashboardBootstrapState({
      hasLocalActiveSession: false,
      hasRecentSessionEndHint: true,
      checkActiveSession,
      fetchBootstrapOpener,
      sleep: async () => undefined,
    });

    expect(checkActiveSession).toHaveBeenCalledTimes(3);
    expect(checkActiveSession).toHaveBeenNthCalledWith(1, true);
    expect(checkActiveSession).toHaveBeenNthCalledWith(2, true);
    expect(checkActiveSession).toHaveBeenNthCalledWith(3, true);
    expect(fetchBootstrapOpener).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe('opener');
    if (result.mode === 'opener') {
      expect(result.opener.suggested_ritual).toBe('prepare');
    }
  });

  it('falls back to local resume when no opener is available', async () => {
    const checkActiveSession = vi.fn().mockResolvedValue({ has_active_session: false });
    const fetchBootstrapOpener = vi.fn().mockResolvedValue({
      success: true,
      data: {
        opener_text: '',
        suggested_ritual: null,
        emotional_context: null,
        has_opener: false,
      },
    });

    const result = await resolveDashboardBootstrapState({
      hasLocalActiveSession: true,
      hasRecentSessionEndHint: false,
      checkActiveSession,
      fetchBootstrapOpener,
      sleep: async () => undefined,
    });

    expect(result.mode).toBe('resume-local');
  });
});
