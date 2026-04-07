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

  it('defines the chat profile for /chat with free-chat defaults enabled', () => {
    expect(COMPANION_ROUTE_PROFILES.chat).toEqual(
      expect.objectContaining({
        id: 'chat',
        routePath: '/chat',
        includeSessionContext: false,
        enableBootstrap: false,
        enableDebrief: false,
        freeChatDefaults: true,
      })
    );
  });

  it('returns the same profile object when an explicit profile is provided', () => {
    const profile: CompanionRouteProfile = {
      id: 'chat',
      routePath: '/chat',
      description: 'custom profile',
      includeSessionContext: false,
      enableBootstrap: false,
      enableDebrief: false,
      freeChatDefaults: true,
    };

    expect(getCompanionRouteProfile(profile)).toBe(profile);
  });
});