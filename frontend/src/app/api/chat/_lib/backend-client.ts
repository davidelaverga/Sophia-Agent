import { getServerAuthToken } from '../../../lib/auth/server-auth';
import { getDevBootstrapToken } from './mock';
import { IS_PRODUCTION, secureLog } from './config';

export interface BackendStreamPayload {
  message: string;
  session_id: string;
  user_id: string;
  session_type?: string;
  context_mode?: string;
  platform?: string;
  language: 'en';
}

export type BackendFetchResult =
  | { ok: true; upstream: Response }
  | {
      ok: false;
      reason: 'auth-missing';
      response: Response;
    };

export async function fetchBackendStreamWithBootstrap(
  backendUrl: string,
  backendPayload: BackendStreamPayload,
): Promise<BackendFetchResult> {
  const callBackend = (authToken: string) => fetch(backendUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(backendPayload),
  });

  let tokenForBackend = await getServerAuthToken();

  if (!tokenForBackend && !IS_PRODUCTION) {
    const bootstrapToken = await getDevBootstrapToken();
    if (bootstrapToken) {
      tokenForBackend = bootstrapToken;
      secureLog('[/api/chat] dev token bootstrap succeeded (missing token)');
    }
  }

  if (!tokenForBackend) {
    return {
      ok: false,
      reason: 'auth-missing',
      response: new Response(
        JSON.stringify({
          error: 'Authentication required',
          auth: false,
          code: 'PROXY_AUTH_MISSING',
        }),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    };
  }

  let upstream = await callBackend(tokenForBackend);

  if (!upstream.ok) {
    let errorText = await upstream.text();

    const lowerErrorText = errorText.toLowerCase();
    const shouldBootstrapDevToken =
      !IS_PRODUCTION &&
      upstream.status === 401 &&
      (
        lowerErrorText.includes('invalid token format') ||
        lowerErrorText.includes('invalid or expired token')
      );

    if (shouldBootstrapDevToken) {
      const bootstrapToken = await getDevBootstrapToken();
      if (bootstrapToken) {
        upstream = await callBackend(bootstrapToken);
        if (upstream.ok) {
          secureLog('[/api/chat] dev token bootstrap succeeded');
        } else {
          errorText = await upstream.text();
        }
      }
    }
  }

  return {
    ok: true,
    upstream,
  };
}
