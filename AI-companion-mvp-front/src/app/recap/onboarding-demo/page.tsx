'use client';

import { ProtectedRoute } from '../../components/ProtectedRoute';
import { OnboardingRecapExperience } from '../../components/onboarding/OnboardingRecapExperience';

export default function OnboardingRecapPage() {
  return (
    <ProtectedRoute>
      <OnboardingRecapExperience />
    </ProtectedRoute>
  );
}