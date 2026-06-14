'use client';

import { useRouter } from 'next/navigation';

import { ArtifactLibraryPanel } from '../components/dashboard/ArtifactLibraryPanel';
import { MobileNavBar, NavRail } from '../components/dashboard/NavRail';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { selectOpenSessionCount, useSessionStore } from '../stores/session-store';

function ArtifactLibraryPageContent() {
  const router = useRouter();
  const openSessionCount = useSessionStore(selectOpenSessionCount);

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#010106]">
      <NavRail
        activeItem="artifacts"
        onToggleSessions={() => router.push('/')}
        sessionsExpanded={false}
        sessionCount={openSessionCount}
        onOpenSettings={() => router.push('/settings')}
      />
      <MobileNavBar
        activeItem="artifacts"
        onOpenSessions={() => router.push('/')}
        sessionCount={openSessionCount}
        onOpenSettings={() => router.push('/settings')}
      />
      <ArtifactLibraryPanel />
    </div>
  );
}

export default function ArtifactsPage() {
  return (
    <ProtectedRoute>
      <ArtifactLibraryPageContent />
    </ProtectedRoute>
  );
}
