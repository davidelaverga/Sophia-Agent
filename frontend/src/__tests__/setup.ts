/**
 * Vitest Test Setup
 * Configures testing environment for React/Next.js
 */

import '@testing-library/jest-dom';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);

const shouldSuppressTestNoise = (value: unknown) =>
  typeof value === 'string' && (
    (value.includes('ReactDOMTestUtils.act') && value.includes('deprecated')) ||
    value.includes('[OfflineQueue] No processor registered for type: test')
  );

// =============================================================================
// GLOBAL MOCKS
// =============================================================================

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

// Mock next/headers (for server components)
vi.mock('next/headers', () => ({
  cookies: () => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  }),
  headers: () => new Headers(),
}));

// =============================================================================
// BROWSER API MOCKS
// =============================================================================

// LocalStorage mock
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value.toString(); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

Object.defineProperty(window, 'sessionStorage', {
  value: localStorageMock,
  writable: true,
});

// Match media mock
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// ResizeObserver mock
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// IntersectionObserver mock
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
  root: null,
  rootMargin: '',
  thresholds: [],
}));

// Fetch mock (can be overridden per test)
global.fetch = vi.fn();

// AudioContext mock
global.AudioContext = vi.fn().mockImplementation(() => ({
  createGain: vi.fn(() => ({
    connect: vi.fn(),
    gain: { value: 1 },
  })),
  createOscillator: vi.fn(() => ({
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  })),
  destination: {},
  sampleRate: 44100,
  close: vi.fn(),
}));

// MediaRecorder mock
const MediaRecorderMock = vi.fn().mockImplementation(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  ondataavailable: vi.fn(),
  onerror: vi.fn(),
  state: 'inactive',
})) as unknown as typeof MediaRecorder;
MediaRecorderMock.isTypeSupported = vi.fn().mockReturnValue(true);
global.MediaRecorder = MediaRecorderMock;

// =============================================================================
// ENVIRONMENT
// =============================================================================

// Default env vars for tests
process.env.NEXT_PUBLIC_API_URL = 'http://localhost:8000';
process.env.NEXT_PUBLIC_SENTRY_DSN = '';
// NODE_ENV is already set by vitest

// =============================================================================
// CLEANUP
// =============================================================================

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (shouldSuppressTestNoise(args[0])) return;
    originalConsoleError(...args);
  });

  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    if (shouldSuppressTestNoise(args[0])) return;
    originalConsoleWarn(...args);
  });
});

afterEach(() => {
  // Clear all mocks after each test
  vi.clearAllMocks();
  // Clear localStorage
  localStorageMock.clear();
});

afterAll(() => {
  // Cleanup after all tests
  vi.restoreAllMocks();
});
