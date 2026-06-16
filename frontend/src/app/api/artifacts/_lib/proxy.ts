import { type NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'crypto';

import {
  getAuthenticatedUserId,
  getUserScopedAuthHeader,
  refreshUserScopedAuthHeader,
} from '../../../lib/auth/server-auth';
import { getPrimaryGatewayUrl } from '../../_lib/gateway-url';

const BACKEND_URL = getPrimaryGatewayUrl();
const ARTIFACT_PROXY_LOG_BODY_LIMIT = 1200;

function shortHash(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function shortText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? `${trimmed.slice(0, 12)}:${trimmed.length}` : null;
}

function payloadShape(body: string | null | undefined): Record<string, unknown> {
  if (!body) {
    return { body_present: false };
  }

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return {
      body_present: true,
      thread_id_present: typeof parsed.thread_id === 'string' && parsed.thread_id.trim().length > 0,
      thread_id: shortText(parsed.thread_id),
      parent_thread_id_present: typeof parsed.parent_thread_id === 'string' && parsed.parent_thread_id.trim().length > 0,
      parent_thread_id: shortText(parsed.parent_thread_id),
      task_id_present: typeof parsed.task_id === 'string' && parsed.task_id.trim().length > 0,
      task_id: shortText(parsed.task_id),
      task_id_hash: typeof parsed.task_id === 'string' ? shortHash(parsed.task_id) : null,
      run_id_present: typeof parsed.run_id === 'string' && parsed.run_id.trim().length > 0,
      run_id: shortText(parsed.run_id),
      run_id_hash: typeof parsed.run_id === 'string' ? shortHash(parsed.run_id) : null,
      task_id_equals_run_id: typeof parsed.task_id === 'string'
        && typeof parsed.run_id === 'string'
        && parsed.task_id.trim() === parsed.run_id.trim(),
      user_id_present: typeof parsed.user_id === 'string' && parsed.user_id.trim().length > 0,
      user_id_hash: typeof parsed.user_id === 'string' ? shortHash(parsed.user_id) : null,
      filename_present: typeof parsed.filename === 'string' && parsed.filename.trim().length > 0,
      filename: typeof parsed.filename === 'string' ? parsed.filename.slice(0, 80) : null,
      local_path_present: typeof parsed.local_path === 'string' && parsed.local_path.trim().length > 0,
      local_path: typeof parsed.local_path === 'string' ? `${parsed.local_path.slice(0, 120)}:${parsed.local_path.length}` : null,
      artifact_id_present: typeof parsed.artifact_id === 'string' && parsed.artifact_id.trim().length > 0,
      artifact_id: shortText(parsed.artifact_id),
      storage_provider_present: typeof parsed.storage_provider === 'string' && parsed.storage_provider.trim().length > 0,
      storage_provider: typeof parsed.storage_provider === 'string' ? parsed.storage_provider.slice(0, 40) : null,
      storage_object_path_present: typeof parsed.storage_object_path === 'string' && parsed.storage_object_path.trim().length > 0,
      storage_object_path: typeof parsed.storage_object_path === 'string'
        ? `${parsed.storage_object_path.slice(0, 120)}:${parsed.storage_object_path.length}`
        : null,
    };
  } catch {
    return {
      body_present: true,
      body_json: false,
      body_length: body.length,
    };
  }
}

function legacyRunIdRetryBody(body: string | null | undefined): string | null {
  if (!body) {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (typeof parsed.run_id !== 'string' || parsed.run_id.trim().length === 0) {
      return null;
    }
    const nextBody = { ...parsed };
    delete nextBody.run_id;
    return JSON.stringify(nextBody);
  } catch {
    return null;
  }
}

function isLegacyRunIdThreadReferenceRejection(status: number, responseText: string): boolean {
  return status === 403 && responseText.includes('Artifact references an unauthorized thread');
}

function copyResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const headerName of [
    'cache-control',
    'content-disposition',
    'content-length',
    'content-type',
    'etag',
    'last-modified',
  ]) {
    const value = source.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }
  return headers;
}

export async function proxyArtifactRegistryRequest(
  req: NextRequest,
  path: string,
  init: { method: 'DELETE' | 'GET' | 'POST'; body?: string | null },
): Promise<Response> {
  const authHeader = await getUserScopedAuthHeader();
  if (!authHeader) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const authenticatedUserId = await getAuthenticatedUserId();
  const traceId = randomUUID();

  const url = new URL(`${BACKEND_URL}/api/artifacts${path}`);
  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const execute = (authorization: string, body: string | null | undefined = init.body) => fetch(url.toString(), {
    method: init.method,
    headers: {
      Authorization: authorization,
      'x-sophia-artifact-trace-id': traceId,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ?? undefined,
    cache: 'no-store',
    redirect: 'follow',
  });

  let authorizationForBackend = authHeader;
  let backendResponse = await execute(authorizationForBackend);

  if (backendResponse.status === 401) {
    const refreshedAuthHeader = await refreshUserScopedAuthHeader();
    if (refreshedAuthHeader && refreshedAuthHeader !== authHeader) {
      authorizationForBackend = refreshedAuthHeader;
      backendResponse = await execute(authorizationForBackend);
    }
  }

  if (!backendResponse.ok) {
    const responseText = await backendResponse.text();
    const backendHost = (() => {
      try {
        return new URL(BACKEND_URL).host;
      } catch {
        return 'invalid-backend-url';
      }
    })();

    console.warn('[artifact-proxy] upstream_non_2xx', {
      route: `${init.method} ${req.nextUrl.pathname}`,
      upstream_path: `/api/artifacts${path}`,
      trace_id: traceId,
      upstream_status: backendResponse.status,
      upstream_body: responseText.slice(0, ARTIFACT_PROXY_LOG_BODY_LIMIT),
      authorization_sent: true,
      gateway_host: backendHost,
      authenticated_user_hash: shortHash(authenticatedUserId),
      payload: payloadShape(init.body),
    });

    if (init.method === 'POST' && path === '/upsert' && isLegacyRunIdThreadReferenceRejection(backendResponse.status, responseText)) {
      const retryBody = legacyRunIdRetryBody(init.body);
      if (retryBody) {
        const retryResponse = await execute(authorizationForBackend, retryBody);
        if (!retryResponse.ok) {
          const retryResponseText = await retryResponse.text();
          console.warn('[artifact-proxy] legacy_run_id_retry_non_2xx', {
            route: `${init.method} ${req.nextUrl.pathname}`,
            upstream_path: `/api/artifacts${path}`,
            trace_id: traceId,
            upstream_status: retryResponse.status,
            upstream_body: retryResponseText.slice(0, ARTIFACT_PROXY_LOG_BODY_LIMIT),
            authorization_sent: true,
            gateway_host: backendHost,
            authenticated_user_hash: shortHash(authenticatedUserId),
            payload: payloadShape(retryBody),
          });
          return new Response(retryResponseText, {
            status: retryResponse.status,
            headers: copyResponseHeaders(retryResponse.headers),
          });
        }
        console.warn('[artifact-proxy] legacy_run_id_retry_succeeded', {
          route: `${init.method} ${req.nextUrl.pathname}`,
          upstream_path: `/api/artifacts${path}`,
          trace_id: traceId,
          gateway_host: backendHost,
          authenticated_user_hash: shortHash(authenticatedUserId),
          original_payload: payloadShape(init.body),
          retried_payload: payloadShape(retryBody),
        });
        return new Response(retryResponse.body, {
          status: retryResponse.status,
          headers: copyResponseHeaders(retryResponse.headers),
        });
      }
    }

    return new Response(responseText, {
      status: backendResponse.status,
      headers: copyResponseHeaders(backendResponse.headers),
    });
  }

  return new Response(backendResponse.body, {
    status: backendResponse.status,
    headers: copyResponseHeaders(backendResponse.headers),
  });
}
