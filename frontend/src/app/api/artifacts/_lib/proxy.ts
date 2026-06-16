import { createHash, randomUUID } from 'crypto';

import { type NextRequest, NextResponse } from 'next/server';

import {
  getAuthenticatedUserId,
  getUserScopedAuthHeader,
  refreshUserScopedAuthHeader,
} from '../../../lib/auth/server-auth';
import { getPrimaryGatewayUrl } from '../../_lib/gateway-url';

const BACKEND_URL = getPrimaryGatewayUrl();
const ARTIFACT_PROXY_LOG_BODY_LIMIT = 1200;
const ARTIFACT_LIST_ROUTE = '';
const KNOWN_ARTIFACT_ID = 'artifact_2f8254e3547d87ab29e56bef';

type DiagnosticSummary = {
  json_parse_ok: boolean;
  top_level_type: string;
  array_length?: number;
  top_level_keys?: string[];
  artifacts_length?: number;
  items_length?: number;
  records_length?: number;
  data_length?: number;
  known_artifact_present: boolean;
};

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

function copyResponseHeaders(source: Headers, options?: { omitContentLength?: boolean }): Headers {
  const headers = new Headers();
  for (const headerName of [
    'cache-control',
    'content-disposition',
    'content-length',
    'content-type',
    'etag',
    'last-modified',
  ]) {
    if (options?.omitContentLength && headerName === 'content-length') {
      continue;
    }
    const value = source.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }
  return headers;
}

function getTopLevelType(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value === null) {
    return 'null';
  }
  return typeof value;
}

function getArrayLength(value: unknown, key: string): number | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return undefined;
  }
  const child = (value as Record<string, unknown>)[key];
  return Array.isArray(child) ? child.length : undefined;
}

function containsKnownArtifact(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsKnownArtifact(item));
  }
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (
    record.artifact_id === KNOWN_ARTIFACT_ID ||
    record.artifactId === KNOWN_ARTIFACT_ID ||
    record.id === KNOWN_ARTIFACT_ID
  ) {
    return true;
  }

  return ['artifacts', 'items', 'records', 'data'].some((key) => containsKnownArtifact(record[key]));
}

function summarizeUpstreamJsonBody(bodyText: string): DiagnosticSummary {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    const topLevelType = getTopLevelType(parsed);
    const summary: DiagnosticSummary = {
      json_parse_ok: true,
      top_level_type: topLevelType,
      known_artifact_present: containsKnownArtifact(parsed),
    };

    if (Array.isArray(parsed)) {
      summary.array_length = parsed.length;
    } else if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      summary.top_level_keys = Object.keys(record).slice(0, 30);
      summary.artifacts_length = getArrayLength(record, 'artifacts');
      summary.items_length = getArrayLength(record, 'items');
      summary.records_length = getArrayLength(record, 'records');
      summary.data_length = getArrayLength(record, 'data');
    }

    return summary;
  } catch {
    return {
      json_parse_ok: false,
      top_level_type: 'string',
      known_artifact_present: false,
    };
  }
}

function resolveTraceId(req: NextRequest): string {
  return req.headers.get('x-sophia-artifact-trace-id')?.trim() || randomUUID();
}

async function getDiagnosticUserId(): Promise<string | null> {
  try {
    return await getAuthenticatedUserId();
  } catch {
    return null;
  }
}

function isRegistryListRequest(path: string, method: string): boolean {
  return path === ARTIFACT_LIST_ROUTE && method.toUpperCase() === 'GET';
}

export async function proxyArtifactRegistryRequest(
  req: NextRequest,
  path: string,
  init: { method: 'DELETE' | 'GET' | 'POST'; body?: string | null },
): Promise<Response> {
  const traceId = resolveTraceId(req);
  const isListRequest = isRegistryListRequest(path, init.method);
  const diagnosticUserId = isListRequest ? await getDiagnosticUserId() : null;
  const authHeader = await getUserScopedAuthHeader();
  if (!authHeader) {
    if (isListRequest) {
      console.info('[artifact-registry-list-proxy]', {
        event: 'artifact_registry_list_proxy_result',
        trace_id: traceId,
        route: '/api/artifacts',
        method: init.method,
        authenticated_session_present: Boolean(diagnosticUserId),
        authenticated_vercel_user_hash: shortHash(diagnosticUserId),
        backend_auth_header_present: false,
        upstream_status: null,
        upstream_content_type: null,
        json_parse_ok: null,
        top_level_type: null,
        known_artifact_present: false,
        final_response_status: 401,
      });
    }
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const authenticatedUserId = isListRequest ? diagnosticUserId : await getAuthenticatedUserId();

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

  if (isListRequest) {
    const responseBody = await backendResponse.text();
    const upstreamContentType = backendResponse.headers.get('content-type');
    const summary = summarizeUpstreamJsonBody(responseBody);

    console.info('[artifact-registry-list-proxy]', {
      event: 'artifact_registry_list_proxy_result',
      trace_id: traceId,
      route: '/api/artifacts',
      method: init.method,
      authenticated_session_present: Boolean(diagnosticUserId),
      authenticated_vercel_user_hash: shortHash(diagnosticUserId),
      backend_auth_header_present: true,
      upstream_status: backendResponse.status,
      upstream_content_type: upstreamContentType,
      ...summary,
      final_response_status: backendResponse.status,
    });

    return new Response(responseBody, {
      status: backendResponse.status,
      headers: copyResponseHeaders(backendResponse.headers, { omitContentLength: true }),
    });
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
