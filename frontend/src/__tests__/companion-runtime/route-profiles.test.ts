import { describe, expect, it } from 'vitest';

import {
  COMPANION_ROUTE_PROFILES,
  getCompanionRouteProfile,
  type CompanionRouteProfile,
} from '../../app/companion-runtime/route-profiles';

describe('companion route profiles', () => {
  it('defines the ritual profile for /session with session context enabled', () => {
    expect(COMPANION_ROUTE_PROFILES.ritual).toEqual(
      expect.objectContaining({
        id: 'ritual',
        routePath: '/session',
        includeSessionContext: true,
        enableBootstrap: true,
        enableDebrief: true,
        freeChatDefaults: false,
      })
    );
  });

  it('returns the same profile object when an explicit profile is provided', () => {
    const profile: CompanionRouteProfile = {
      id: 'ritual',
      routePath: '/session',
      description: 'custom profile',
      includeSessionContext: true,
      enableBootstrap: true,
      enableDebrief: true,
      freeChatDefaults: false,
    };

    expect(getCompanionRouteProfile(profile)).toBe(profile);
  });
});