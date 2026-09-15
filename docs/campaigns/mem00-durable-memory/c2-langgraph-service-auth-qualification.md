# C2 LangGraph service authentication primitives

This additive slice does not activate LangGraph authentication, register a route,
change existing callers, or deploy any component. Parent: d4436b893f121db698b940e09c98afff9f2115df.

It contains the owner/method/path-scoped service-token primitive and the SDK
client adapter. Tokens use the existing Builder-events secret under a separate
protocol domain and a 30-second validity interval. They are not one-use memory
admissions. Verification of thread ownership and current memory authority remains
the responsibility of the runtime serving policy, outside this slice.

The SDK adapter binds each request to the current task's owner context rather
than caching an owner's credential in a shared client. It does not forward an
incidental LangSmith API key. In-process SDK transport retains its native auth
context. Production remote calls require owner scope; missing owner context denies.
The adapter only affects callers which explicitly import and use it.

Qualification: 8e75a3 passed 26 focused tests through the frozen Python 3.12 uv
environment. Coverage includes method/path/expiry/key mismatch, malformed scope,
Voice Lab principal refusal, readiness isolation, concurrent owner contexts,
exception reset, and installed SDK construction without incidental API-key
forwarding. Test credentials are synthetic; no provider or production calls.
Direct repository dependencies already exist unchanged at the parent revision.

Remaining integration includes receiving runtime policy, verified route callers,
internal worker compatibility, production ownership checks, and the C2 rollout
and no-legacy rollback gates. Passing these primitive tests does not establish
hosted authentication, memory admission, or pilot readiness. No credentials,
service settings, billing, schema, or Mem0 dependency were changed.
