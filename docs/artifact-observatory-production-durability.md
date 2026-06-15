# Artifact Observatory Production Durability

Production Artifact Observatory rollout is only valid when Gateway metadata and
Builder artifact bytes are both durable.

## Gateway

Required:

- `SOPHIA_ARTIFACT_REGISTRY_STORE=supabase`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_BUILDER_BUCKET`

Must remain unset or false:

- `SOPHIA_ALLOW_LOCAL_ARTIFACT_REGISTRY_IN_PRODUCTION`
- `SOPHIA_AUTH_BYPASS`

Gateway also needs a production auth backend URL through `SOPHIA_AUTH_BACKEND_URL`,
`BACKEND_API_URL`, or `VOICE_SERVER_URL`.

`SOPHIA_ARTIFACT_REGISTRY_STORE=hybrid` is a migration or staging mode only. It
is not the recommended production source of truth because the local side can be
ephemeral.

## LangGraph / Builder Worker

Required:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_BUILDER_BUCKET`

Optional and recommended:

- `SOPHIA_SUPABASE_MIRROR_ALL=true`

Final Builder artifact emits still require upload and object-existence
verification in production Supabase registry mode, even when
`SOPHIA_SUPABASE_MIRROR_ALL` is false.

## Frontend

Set only the Gateway URL env used by the deployment, such as
`NEXT_PUBLIC_GATEWAY_URL`, `RENDER_BACKEND_URL`, `BACKEND_API_URL`, or
`NEXT_PUBLIC_API_URL`.

Never expose `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_KEY`, or bucket credentials
to the frontend.

## Storage And Migration

- Run `backend/migrations/2026_06_12_artifact_registry_records.sql` before
  enabling production Supabase registry mode.
- Create the private Supabase Storage bucket before deploy.
- Set `SUPABASE_BUILDER_BUCKET` explicitly in production. Local code can still
  default to `sophia-builder-artifacts`, but production must not depend on that
  default.
- Run a live smoke test after deploy: create an artifact, verify the metadata
  row and storage object exist, restart Gateway and LangGraph, refresh
  `/artifacts`, preview/download by artifact id, delete, refresh, and confirm
  deleted artifact preview/download return 404.

## Delete Policy

`DELETE /api/artifacts/{artifact_id}` is intentionally a soft delete:
`deleted_at` is set and `is_library_visible=false`. Deleted artifacts cannot be
opened, previewed, or downloaded even if bytes remain in Supabase Storage.

Hard deletion of storage objects is not part of the dashboard delete path.
Object cleanup should be handled by a separate scheduled retention or cleanup
task.
