import { debugLog } from '../../../lib/debug-logger';

export const BACKEND_URL = process.env.SOPHIA_LANGGRAPH_BASE_URL || process.env.NEXT_PUBLIC_LANGGRAPH_BASE_URL || 'http://localhost:2024';
export const BACKEND_CHAT_ENDPOINT = '/threads';
export const SOPHIA_ASSISTANT_ID = process.env.SOPHIA_ASSISTANT_ID || 'sophia_companion';
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const AI_SDK_STREAM_HEADER = 'x-vercel-ai-ui-message-stream';
export const USE_MOCK = process.env.USE_MOCK_STREAMING === 'true';

export function secureLog(message: string, data?: object): void {
  if (!IS_PRODUCTION) {
    debugLog('api/chat', message, data ? JSON.stringify(data, null, 2) : '');
  }
}