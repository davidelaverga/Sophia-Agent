import { NextResponse } from 'next/server';

// Keep this endpoint source-bound so every governed Voice Lab candidate
// produces a distinct Vercel build instead of being skipped by the
// ignored-build gate, including worker-only startup evidence fixes.
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
    memory_contract_schema: 'mem00.v1',
    memory_supported_contract_epoch: 1,
  });
  return NextResponse.json(
    {
      build_id: buildId,
      deployment_id: deploymentId,
      memory_contract_schema: 'mem00.v1',
      memory_supported_contract_epoch: 1,
    },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    },
  );
}
