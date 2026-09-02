import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../app/components/AuthGate', () => ({
  // Reaching this subtree proves that the real AuthGate has authenticated the
  // session. Deliberately expose no second callback contract.
  AuthGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('../../app/components/ConsentGate', () => ({
  ConsentGate: ({ onReady }: { onReady: () => void }) => (
    <button type="button" onClick={onReady}>accept consent</button>
  ),
}))

import { ProtectedRoute } from '../../app/components/ProtectedRoute'

describe('ProtectedRoute', () => {
  afterEach(() => {
    window.localStorage.clear()
  })

  it('uses AuthGate as the sole auth boundary and advances through consent', () => {
    render(<ProtectedRoute><p>protected content</p></ProtectedRoute>)

    expect(screen.getByRole('button', { name: 'accept consent' })).toBeInTheDocument()
    expect(screen.queryByText('protected content')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'accept consent' }))

    expect(screen.getByText('protected content')).toBeInTheDocument()
  })

  it('renders protected content immediately after AuthGate when consent is skipped', () => {
    render(<ProtectedRoute skipConsent><p>protected content</p></ProtectedRoute>)

    expect(screen.getByText('protected content')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'accept consent' })).not.toBeInTheDocument()
  })

  it('releases a cached-consent protected route without waiting for the consent child effect', () => {
    window.localStorage.setItem('sophia_consent_accepted', 'true')

    render(<ProtectedRoute><p>protected content</p></ProtectedRoute>)

    expect(screen.getByText('protected content')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'accept consent' })).not.toBeInTheDocument()
  })
})
