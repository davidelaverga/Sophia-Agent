'use client';

import { ArtifactLibraryPanel } from '../components/dashboard/ArtifactLibraryPanel';
import { ProtectedRoute } from '../components/ProtectedRoute';

function ArtifactLibraryPageContent() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#010106]">
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
