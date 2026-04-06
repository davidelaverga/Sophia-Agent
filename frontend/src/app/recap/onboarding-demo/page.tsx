'use client';

import { OnboardingRecapExperience } from '../../components/onboarding/OnboardingRecapExperience';
import { ProtectedRoute } from '../../components/ProtectedRoute';

export default function OnboardingRecapPage() {
  return (
    <ProtectedRoute>
      <OnboardingRecapExperience />
    </ProtectedRoute>
  );
}