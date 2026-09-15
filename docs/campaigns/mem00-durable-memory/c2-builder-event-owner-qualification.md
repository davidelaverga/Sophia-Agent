# C2 Builder completion event ownership

Parent: bb7c10dcde2103d8378f63587a6d3428d3c3f67d.

This slice connects the existing exact-body authenticated completion webhook to
the published owner-scoped SDK adapter. Hydration of the parent's tracked task
and persistence of terminal state run under the signed event's owner. An event
without an owner clears ambient owner context rather than borrowing it. Runtime
thread-ownership policy remains an independent required serving check.

The receiving route retains its existing authentication dependency. No new route,
secret, schema, consumer profile, or runtime auth activation is introduced.
Seven existing SDK factory fixtures accept the explicit api_key=None argument;
their runtime assertions remain unchanged.

The new test exercises the real FastAPI route and body signature with concurrent
synthetic owners. It verifies downstream method/path-bound credentials for
hydration and persistence, denies an unsigned event, and checks that a signed
ownerless event cannot make a downstream request with borrowed context. The
runtime HTTP transport is synthetic; it does not prove production ownership,
artifact storage, final memory admission, or hosted completion delivery.

Qualification: 2e3d89 passed49 focused tests in the working environment. A clean
archive of the staged backend was then tested with explicit archived import-path
assertions: 893da8 passed49. This uses the existing frozen uv dependency environment
without importing the unpublished Gateway code. Two warnings remain. No live
provider or production requests were made.

Existing synthetic-cleanup/enumeration callers are outside this slice. Do not
activate global LangGraph authentication until all necessary internal callers
are compatible and the C2 rollout/rollback requirements are satisfied. Shared
deployment coordination is still required; publication is not deployment.
