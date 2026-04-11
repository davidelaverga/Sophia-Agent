import { headers } from "next/headers";
import { cache } from "react";

import { authBypassEnabled, authBypassUserId } from "@/app/lib/auth/dev-bypass";

function buildSyntheticSession() {
  return {
    session: {
      token: "auth-bypass",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
    user: {
      id: authBypassUserId,
      email: null,
      name: "Sophia User",
    },
  };
}

export const getSession = cache(async () => {
  if (authBypassEnabled) {
    return buildSyntheticSession();
  }

  const [{ auth }, { ensureBetterAuthSchema }] = await Promise.all([
    import("./config"),
    import("./migrations"),
  ]);

  await ensureBetterAuthSchema();
  return auth.api.getSession({ headers: await headers() });
});
