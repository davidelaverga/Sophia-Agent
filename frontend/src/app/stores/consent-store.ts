/**
 * Consent Store
 * Phase 3 - Week 3
 * 
 * Manages user consent state for privacy and memory features.
 * Persists to localStorage for session continuity.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

// =============================================================================
// TYPES
// =============================================================================

interface ConsentState {
  /** User has accepted privacy policy */
  privacy: boolean;
  
  /** User has accepted memory storage */
  memoryStorage: boolean;
  
  /** User has accepted analytics */
  analytics: boolean;
  
  /** Timestamp of last consent update */
  lastUpdated: string | null;
  
  /** Actions */
  setPrivacyConsent: (accepted: boolean) => void;
  setMemoryStorageConsent: (accepted: boolean) => void;
  setAnalyticsConsent: (accepted: boolean) => void;
  setAllConsents: (privacy: boolean, memoryStorage: boolean, analytics: boolean) => void;
  resetConsents: () => void;
  
  /** Check if user can save memories */
  canSaveMemories: () => boolean;
}

// =============================================================================
// STORE
// =============================================================================

export const useConsentStore = create<ConsentState>()(
  persist(
    (set, get) => ({
      privacy: false,
      memoryStorage: false,
      analytics: false,
      lastUpdated: null,
      
      setPrivacyConsent: (accepted) => {
        set({
          privacy: accepted,
          lastUpdated: new Date().toISOString(),
        });
      },
      
      setMemoryStorageConsent: (accepted) => {
        set({
          memoryStorage: accepted,
          lastUpdated: new Date().toISOString(),
        });
      },
      
      setAnalyticsConsent: (accepted) => {
        set({
          analytics: accepted,
          lastUpdated: new Date().toISOString(),
        });
      },
      
      setAllConsents: (privacy, memoryStorage, analytics) => {
        set({
          privacy,
          memoryStorage,
          analytics,
          lastUpdated: new Date().toISOString(),
        });
      },
      
      resetConsents: () => {
        set({
          privacy: false,
          memoryStorage: false,
          analytics: false,
          lastUpdated: new Date().toISOString(),
        });
      },
      
      canSaveMemories: () => {
        const state = get();
        return state.privacy && state.memoryStorage;
      },
    }),
    {
      name: 'sophia-consent',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        privacy: state.privacy,
        memoryStorage: state.memoryStorage,
        analytics: state.analytics,
        lastUpdated: state.lastUpdated,
      }),
    }
  )
);

// =============================================================================
// SELECTORS
// =============================================================================

export const selectPrivacyConsent = (state: ConsentState) => state.privacy;
export const selectMemoryStorageConsent = (state: ConsentState) => state.memoryStorage;
export const selectCanSaveMemories = (state: ConsentState) => 
  state.privacy && state.memoryStorage;

export default useConsentStore;
