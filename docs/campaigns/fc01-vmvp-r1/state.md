# FC01-VMVP-R1 — Implementation state

## Candidate

- Target branch: `codex/sophia-observability-v1`
- Frozen packet commit: `b7949605889dc4b3f91793e7b06fc1410619ffc8`
- Local pre-change HEAD: `5fbd98c04496eaec263520631a352b71e32257ab`
- Status: implementation candidate; branch drift from the frozen packet is recorded for review.

## Validation evidence

- Python compilation: passed for voice, gateway routers, and harness DeerFlow modules.
- Frontend TypeScript: passed.
- Frontend Gemini browser dogfood tests: 59 passed.
- Voice browser dogfood focused tests: 51 passed; 6 endpoint tests were deselected because the local virtualenv lacks the optional `vision_agents` package.
- Voice LangSmith/provider focused tests: 41 passed.
- Session/store/gateway regression suite: run before deployment; results are recorded in the handoff.

## Operator gates

- `LANGGRAPH_POSTGRES_DSN` must be configured on both the LangGraph and gateway Render services because both load the production configuration.
- `SOPHIA_VOICE_OBSERVABILITY_HMAC_SECRET` must be configured on the voice Render service for production LangSmith tracing to activate.
- Apply the additive session-message revision migration before relying on revision receipts in Supabase.
