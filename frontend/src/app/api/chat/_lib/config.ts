import { debugLog } from '../../../lib/debug-logger';

export const BACKEND_URL = process.env.RENDER_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
export const BACKEND_CHAT_ENDPOINT = '/api/v1/chat/text/stream';
export const BACKEND_REGISTER_ENDPOINT = '/api/v1/auth/register';
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const AI_SDK_STREAM_HEADER = 'x-vercel-ai-ui-message-stream';
export const USE_MOCK = process.env.USE_MOCK_STREAMING === 'true';

export function secureLog(message: string, data?: object): void {
  if (!IS_PRODUCTION) {
    debugLog('api/chat', message, data ? JSON.stringify(data, null, 2) : '');
  }
}