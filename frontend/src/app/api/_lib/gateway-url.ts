const DEFAULT_GATEWAY_URL = 'http://localhost:8001';

function normalizeUrl(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\/$/, '');
}

function uniqueUrls(values: Array<string | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => normalizeUrl(value)).filter((value): value is string => value !== null)),
  );
}

export function getPrimaryGatewayUrl(): string {
  return uniqueUrls([
    process.env.RENDER_BACKEND_URL,
    process.env.NEXT_PUBLIC_GATEWAY_URL,
    process.env.BACKEND_API_URL,
    process.env.NEXT_PUBLIC_API_URL,
    DEFAULT_GATEWAY_URL,
  ])[0] ?? DEFAULT_GATEWAY_URL;
}

export function getHealthTargetUrls(): string[] {
  return uniqueUrls([
    process.env.RENDER_BACKEND_URL,
    process.env.NEXT_PUBLIC_GATEWAY_URL,
    process.env.BACKEND_API_URL,
    process.env.NEXT_PUBLIC_API_URL,
    DEFAULT_GATEWAY_URL,
  ]);
}