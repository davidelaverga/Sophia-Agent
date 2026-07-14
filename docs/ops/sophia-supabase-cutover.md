# Sophia Supabase Cutover

Production target: `vlxnwmyvhchwbousrdzc`. Source: `qtyqgvdkbhjfmnfkxyvm`.

## Presentation Runtime

The production presentation tier uses a 1,200-second total deadline. Initial
authoring and its single repair share a 720-second cumulative budget; each
model call is limited to 360 seconds. Research preflight and the prepare latch
are both 15 seconds, while 30 seconds are reserved for terminal persistence,
notifications, and cleanup. Native compilation, rendering, image generation,
and preview subprocesses are capped by the remaining shared deadline and must
never publish partial decks.

## Schema Order

Apply these idempotent migrations to the target in order:

1. `backend/migrations/2026_04_25_telegram_user_bindings.sql`
2. `backend/migrations/2026_05_26_sophia_session_transcripts.sql`
3. `backend/migrations/2026_06_12_artifact_registry_records.sql`
4. `backend/migrations/2026_07_11_sophia_build_foundation.sql`
5. `backend/migrations/2026_07_13_sophia_auth_and_storage_convergence.sql`

Then run `backend/migrations/2026_07_13_verify_sophia_target.sql`. It checks all
13 application tables, both runtime build RPCs, private storage, least
privilege, and an append/read probe that is rolled back.

The convergence migration creates `better_auth_app` as `NOLOGIN` and grants it
CRUD access only to Better Auth's four tables. Provision a random LOGIN password
through the SQL Editor during cutover; never store that password in the repo.
Use the dedicated role in Vercel rather than the project owner or service role.

## Data Copy

Run both copy tools without `--apply` first. They report counts and hashes but
never print rows, objects, credentials, or signed URLs.

```bash
cd backend
uv run python scripts/migrate_supabase_project.py

cd ../frontend
pnpm auth:migrate-data
```

After dry-run review, repeat with `--apply` and provide a temporary metadata SQL
path:

```bash
uv run python scripts/migrate_supabase_project.py \
  --apply \
  --metadata-sql-output /tmp/sophia-storage-metadata.sql
```

The backend copier preserves all nine Sophia table records and maps source
bucket `sophia_builder` into private target bucket
`sophia-builder-artifacts`. Run the generated SQL once in the target SQL
Editor; it restores object IDs, timestamps, and MIME/cache metadata inside one
transaction while bytes and paths remain unchanged. Then rerun the copier with
`--apply --verify-storage-metadata` to verify source/target identity, metadata,
paths, and content hashes. Delete the temporary SQL file after verification.
The Better Auth copier preserves users/accounts plus active sessions and
unexpired verification rows.
When database passwords are unavailable during an emergency dashboard-led
cutover, `migrate_supabase_project.py --include-better-auth` can relay the same
four tables through temporary `service_role` grants; revoke those grants before
readiness is declared.

## Coordinated Freeze

Set `SOPHIA_MIGRATION_MAINTENANCE_MODE=true` on Render gateway and Vercel
Production, deploy both, run the incremental copies, then update all production
database variables together. Keep `BETTER_AUTH_SECRET` unchanged. Do not use
`NEXT_PUBLIC_*` for database or service-role credentials.

`BETTER_AUTH_DATABASE_URL` and `DATABASE_URL` may use different roles or direct
versus pooled endpoints, but both must resolve to the same Supabase project and
database name. Startup rejects aliases that resolve to different targets.

Readiness must pass before clearing maintenance mode: expected project refs,
all tables, both RPCs, private bucket access, Better Auth connectivity, and
`build_event_store_status=available`. Roll back Render and Vercel variables as
one unit if any check fails. Keep the source project read-only for seven days.
