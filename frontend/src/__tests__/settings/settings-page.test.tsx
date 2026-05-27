import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const backMock = vi.fn()
const pushMock = vi.fn()
const showToastMock = vi.fn()
const setVoiceOverEnabledMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    back: backMock,
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

vi.mock('../../app/components/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../../app/components/dashboard/EnhancedFieldBackground', () => ({
  EnhancedFieldBackground: () => <div data-testid="field-background" />,
}))

vi.mock('../../app/components/settings/TelegramConnectCard', () => ({
  TelegramConnectCard: () => <div data-testid="telegram-connect-card" />,
}))

vi.mock('../../app/components/settings/VisualQualityPicker', () => ({
  VisualQualityPicker: () => <div data-testid="visual-quality-picker" />,
}))

vi.mock('../../app/hooks/useHaptics', () => ({
  haptic: vi.fn(),
}))

vi.mock('../../app/lib/auth/dev-bypass', () => ({
  authBypassConfiguredValue: '',
  authBypassEnabled: false,
  authBypassSource: null,
}))

vi.mock('../../app/lib/debug-tools', () => ({
  clearLocalSessionData: vi.fn(),
}))

vi.mock('../../app/lib/error-logger', () => ({
  logger: {
    logError: vi.fn(),
  },
}))

vi.mock('../../app/lib/session-teardown', () => ({
  teardownSessionClientState: vi.fn(),
}))

vi.mock('../../app/providers', () => ({
  useAuth: () => ({
    signOut: vi.fn(),
  }),
}))

vi.mock('../../app/stores/auth-token-store', () => ({
  useAuthTokenStore: {
    getState: () => ({
      clearToken: vi.fn(),
    }),
  },
}))

vi.mock('../../app/stores/onboarding-store', () => ({
  useOnboardingStore: (selector: (state: {
    preferences: { voiceOverEnabled: boolean }
    setVoiceOverEnabled: typeof setVoiceOverEnabledMock
  }) => unknown) => selector({
    preferences: { voiceOverEnabled: true },
    setVoiceOverEnabled: setVoiceOverEnabledMock,
  }),
}))

vi.mock('../../app/stores/session-store', () => {
  const state = {
    session: null,
  }

  return {
    selectSession: (store: typeof state) => store.session,
    useSessionStore: (selector: (store: typeof state) => unknown) => selector(state),
  }
})

vi.mock('../../app/stores/ui-store', () => ({
  useUiStore: (selector: (state: { showToast: typeof showToastMock }) => unknown) => selector({
    showToast: showToastMock,
  }),
}))

vi.mock('../../app/stores/usage-limit-store', () => ({
  useUsageLimitStore: (selector: (state: { planTier: string }) => unknown) => selector({
    planTier: 'FREE',
  }),
}))

import SettingsPage from '../../app/settings/page'

describe('SettingsPage', () => {
  beforeEach(() => {
    backMock.mockReset()
    pushMock.mockReset()
    showToastMock.mockReset()
    setVoiceOverEnabledMock.mockReset()
  })

  it('renders the existing /settings page content', () => {
    render(<SettingsPage />)

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByTestId('visual-quality-picker')).toBeInTheDocument()
    expect(screen.getByTestId('telegram-connect-card')).toBeInTheDocument()
  })
})
