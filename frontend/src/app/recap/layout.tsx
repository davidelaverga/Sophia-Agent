/**
 * Recap Layout
 * Unit 8 — R30
 *
 * Dark atmospheric backdrop with PresenceField running at resting state.
 * All recap routes inherit this background.
 */

'use client';

import type { ReactNode } from 'react';

import { PresenceField } from '../components/presence-field';

export default function RecapLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-screen bg-[var(--bg)]">
      {/* PresenceField at resting state — pure ambient, no expression changes */}
      <div className="fixed inset-0 z-0 pointer-events-none" aria-hidden="true">
        <PresenceField />
      </div>

      {/* Page content above the nebula */}
      <div className="relative z-10">
        {children}
      </div>
    </div>
  );
}
