import type { ActiveSessionResponse } from '../types/session';
import type { ApiResponse, BootstrapOpenerResponse } from './api/bootstrap-api';

type ActiveSessionRecord = NonNullable<ActiveSessionResponse['session']>;

export type DashboardBootstrapState =
  | { mode: 'resume-backend'; session: ActiveSessionRecord }
  | { mode: 'resume-local' }
  | { mode: 'opener'; opener: BootstrapOpenerResponse }
  | { mode: 'none' };

interface ResolveDashboardBootstrapParams {
  hasLocalActiveSession: boolean;
  hasRecentSessionEndHint: boolean;
  checkActiveSession: (force?: boolean) => Promise<ActiveSessionResponse | null>;
  fetchBootstrapOpener: () => Promise<ApiResponse<BootstrapOpenerResponse>>;
  sleep?: (ms: number) => Promise<void>;
}

const RECENT_END_RETRY_DELAYS_MS = [0, 700, 1500];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resolveDashboardBootstrapState({
  hasLocalActiveSession,
  hasRecentSessionEndHint,
  checkActiveSession,
  fetchBootstrapOpener,
  sleep = defaultSleep,
}: ResolveDashboardBootstrapParams): Promise<DashboardBootstrapState> {
  const attempts = hasRecentSessionEndHint ? RECENT_END_RETRY_DELAYS_MS.length : 1;

  let backendActiveSession: ActiveSessionRecord | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const delayMs = RECENT_END_RETRY_DELAYS_MS[attempt] ?? 0;
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    const shouldForce = hasRecentSessionEndHint || attempt > 0;
    const active = await checkActiveSession(shouldForce);

    if (active?.has_active_session && active.session) {
      backendActiveSession = active.session;
      continue;
    }

    backendActiveSession = null;
    break;
  }

  if (backendActiveSession) {
    return {
      mode: 'resume-backend',
      session: backendActiveSession,
    };
  }

  const openerResult = await fetchBootstrapOpener();
  if (openerResult.success && openerResult.data.has_opener) {
    return {
      mode: 'opener',
      opener: openerResult.data,
    };
  }

  if (hasLocalActiveSession) {
    return { mode: 'resume-local' };
  }

  return { mode: 'none' };
}
