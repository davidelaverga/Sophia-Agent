# C2 artifact and canvas runtime callers

Parent: a661d6eed6314094e37960eba5a4db82d3b92ade.

This slice routes the existing artifact and Builder canvas LangGraph clients
through the published owner-scoped SDK adapter. Gateway middleware already
establishes the authenticated request owner. No artifact payload schema, serving
policy, memory consumer profile, or runtime auth activation changes here.

The new test runs the installed SDK to its HTTP transport boundary from both
association readers with concurrent synthetic owners. It verifies exact signed
owner/method/path claims and absence of an incidental LangSmith API key. Missing
owner context sends no request: canvas reports its existing HTTP503 outcome;
artifact association returns its existing empty fallback. Neither fallback is
evidence of successful artifact delivery or permission to read another owner.

The HTTP transport remains synthetic. Existing artifact and canvas route suites
are rerun; hosted storage, runtime ownership enforcement, and C2 model admission
remain separate qualification requirements. No production deployment, credentials,
schema, provider configuration, or billing changes are included.

Qualification: 89f662 passed97 in the working environment. e59dfb passed97 against
the archived candidate with explicit archived import assertions (2 warnings).
All artifact and canvas route cases ran, with no deselections.
