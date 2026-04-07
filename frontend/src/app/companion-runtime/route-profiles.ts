export type CompanionRouteProfileId = 'ritual' | 'chat';

export type CompanionRouteProfile = {
  id: CompanionRouteProfileId;
  routePath: '/session' | '/chat';
  description: string;
  includeSessionContext: boolean;
  enableBootstrap: boolean;
  enableDebrief: boolean;
  freeChatDefaults: boolean;
};

export const COMPANION_ROUTE_PROFILES: Record<CompanionRouteProfileId, CompanionRouteProfile> = {
  ritual: {
    id: 'ritual',
    routePath: '/session',
    description: 'Ritual session shell over the canonical companion runtime.',
    includeSessionContext: true,
    enableBootstrap: true,
    enableDebrief: true,
    freeChatDefaults: false,
  },
  chat: {
    id: 'chat',
    routePath: '/chat',
    description: 'Free-chat shell over the canonical companion runtime.',
    includeSessionContext: false,
    enableBootstrap: false,
    enableDebrief: false,
    freeChatDefaults: true,
  },
};

export function getCompanionRouteProfile(
  profile: CompanionRouteProfileId | CompanionRouteProfile
): CompanionRouteProfile {
  if (typeof profile === 'string') {
    return COMPANION_ROUTE_PROFILES[profile];
  }

  return profile;
}