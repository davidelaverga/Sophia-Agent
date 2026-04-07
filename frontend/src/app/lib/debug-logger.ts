export function isDebugLoggingEnabled(): boolean {
  return process.env.NODE_ENV !== 'production';
}

export function debugLog(scope: string, message: string, data?: unknown): void {
  if (!isDebugLoggingEnabled()) return;
  if (typeof data === 'undefined') {
    console.log(`[${scope}] ${message}`);
    return;
  }
  console.log(`[${scope}] ${message}`, data);
}

export function debugInfo(scope: string, message: string, data?: unknown): void {
  if (!isDebugLoggingEnabled()) return;
  if (typeof data === 'undefined') {
    console.info(`[${scope}] ${message}`);
    return;
  }
  console.info(`[${scope}] ${message}`, data);
}

export function debugWarn(scope: string, message: string, data?: unknown): void {
  if (!isDebugLoggingEnabled()) return;
  if (typeof data === 'undefined') {
    console.warn(`[${scope}] ${message}`);
    return;
  }
  console.warn(`[${scope}] ${message}`, data);
}
