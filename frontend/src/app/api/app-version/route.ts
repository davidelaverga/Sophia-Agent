import { NextResponse } from 'next/server';

// Keep this endpoint source-bound so a governed candidate always produces a
// distinct Vercel build instead of being skipped by the ignored-build gate.
function resolveBuildId(): string {
  return (
    process.env.NEXT_PUBLIC_APP_BUILD_ID
    || process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.RENDER_GIT_COMMIT
    || process.env.COMMIT_SHA
    || 'development'
  );
}

export async function GET() {
  const buildId = resolveBuildId();
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_URL || null;
  console.log('[app-version] resolved', {
    build_id: buildId,
    deployment_id: deploymentId,
  });
  return NextResponse.json(
    {
      build_id: buildId,
      deployment_id: deploymentId,
    },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    },
  );
}
