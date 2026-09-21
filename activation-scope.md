# VT00-C5 bounded activation and close scope

Prepared 2026-09-21. Davide subsequently replied "approved activation" in the
Codex task. Approval was relayed to the existing Claude deployment controller,
which accepted the message as turn92 at approximately17:16 UTC. Activation
execution and deployment receipts remain to be verified. The separate proposed
suspension posture below is not inferred from this activation approval.

This scope is for one two-turn installed-plugin
journey, not a full VT00 campaign. Code repair is already deployed. The remaining
configuration deployments were blocked by the deployment controller's recorded
Production Deploy denial. Manual execution or explicit approval through that
controller's supported permission flow is required. Do not switch controllers
to bypass it. MEM00 authorization alone does not authorize these Voice actions.

## Exact components

| Component | Existing service / deployment | Source to preserve |
|---|---|---|
| Frontend | sophia-ei.com, Vercel dpl_99vszUEXAXnZ5LP68EPKWJ3w843t | a5982c6e57efde05311a6add245e0258693f1471 |
| Gateway | srv-d7be5s9r0fns7397l4g0 | 406ff0a6f9d64c04bbfd55ae1ea87b5a559cf490 |
| Voice | sophia-voice-2uzr.onrender.com | 35c6467c36b9ae052ec3dd943cf7c9f0ac28d589 |
| LangGraph | srv-d7be5s9r0fns7397l4fg | 406ff0a6f9d64c04bbfd55ae1ea87b5a559cf490; no configuration change required |
| Lab MCP | srv-da6uiqfavr4c739mtbng | 2deb762a7a03ca7f260ec2efd670b5993f7dc977 |
| Lab worker | srv-da6uiqfavr4c739mtbo0 | 2deb762a7a03ca7f260ec2efd670b5993f7dc977 |

One deployment owner/window, coordinated with MEM00. No overlapping deployment
or active-run restart. Never select the old configured shared branch or uniform
source SHA. Preserve receiving authentication, signing keys, principal, memory
governance, schema, service plans, scaling, resource limits and provider policy.

## Pin reconciliation and opening

On both Lab services set only these expected pins, preserving repository candidate:

```
SOPHIA_VOICE_LAB_EXPECTED_FRONTEND_SHA=a5982c6e57efde05311a6add245e0258693f1471
SOPHIA_VOICE_LAB_EXPECTED_BACKEND_SHA=406ff0a6f9d64c04bbfd55ae1ea87b5a559cf490
SOPHIA_VOICE_LAB_EXPECTED_VOICE_SHA=35c6467c36b9ae052ec3dd943cf7c9f0ac28d589
SOPHIA_VOICE_LAB_EXPECTED_LANGGRAPH_SHA=406ff0a6f9d64c04bbfd55ae1ea87b5a559cf490
SOPHIA_VOICE_LAB_REPOSITORY_CANDIDATE_SHA=2deb762a7a03ca7f260ec2efd670b5993f7dc977
```

For each Render service, choose **Save only** in the environment save dropdown,
then **Manual Deploy → Deploy a specific commit** at the exact source above.
Do not allow an automatic branch build and try to replace it afterward.
Render documents Save only as persisting variables without triggering deployment:
https://render.com/docs/configure-environment-variables . Its separate Save and
deploy option reuses the existing build; do not confuse either option with Save,
rebuild, and deploy. This scope uses Save only plus the explicit commit workflow.

Save configuration without automatically deploying an unrelated branch. Every
deployment must retain the exact component source above. Keep MCP admission
closed through the product and worker changes.

1. Frontend: `SOPHIA_VOICE_LAB_ENABLED=true`,
   `SOPHIA_VOICE_LAB_CONTROL_ADAPTER_ENABLED=true`,
   `SOPHIA_VOICE_LAB_KILL_SWITCH=false`. Provisioning remains disabled. Rebuild
   the exact frontend source for the Production target using current Production
   environment values. Use the existing production deployment's redeploy flow,
   with the Ignore Build Step override unchecked for that rebuild as in C3.
   Never promote a Preview-built artifact: public auth-bypass settings are baked
   into the browser bundle. Preserve production auth settings, verify the resulting
   production-domain deployment, signed readiness and deployment ID.
2. Gateway, then Voice: `SOPHIA_VOICE_LAB_ENABLED=true` and
   `SOPHIA_VOICE_LAB_KILL_SWITCH=false`. Verify each exact-source deployment,
   readiness and mutation readiness before proceeding; Gateway admission must
   remain ready with the accepted historical inventory explicitly unverified.
3. Worker: corrected pins and `SOPHIA_VOICE_LAB_KILL_SWITCH=false` on source2deb.
   Verify one fresh singleton heartbeat, exact pins, browser and fixture health.
4. MCP last: corrected pins and `SOPHIA_VOICE_LAB_KILL_SWITCH=false` on source2deb.
   Require settled execution gate, all exact identities, signed frontend
   readiness, product gates open and mutation_ready=true before any run.

## One bounded run and settlement

Existing installed plugin only; existing dedicated synthetic principal and OAuth
scopes. V-O01 plus explicit two-turn/end audit. One run, two short adaptive TTS
utterances, concurrency one; existing ceiling 30 minutes, 30 seconds per
utterance, 180 seconds injected audio remains unchanged. No Builder request,
fault, reconnect, endurance or regression suite. Raw audio/video off, screenshots
allowed and evidence retention24h. Existing provider authorization only; no new
service, recurring spend, budget change or limit expansion.

Observe real first reply before choosing turn two. Require source/scheduling/PCM,
input transcription, provider output and actual playback chains. End through
the plugin, export after finalization, retain durable evidence and verify all
current browser/media/provider/session/Builder resources. Historical exceptions
do not apply to this run. A failed start still requires supported end/recovery
and resource settlement; no blind new-key retry or new run is authorized here.

## Closing and proposed suspension

Close MCP admission first and verify it, retaining inspect/recovery until owned
resources are settled. Then close worker execution and verify a fresh singleton
closed heartbeat and settled execution gate. Close Gateway and Voice with enabled
false/kill switch true, preserving exact sources. Close frontend with enabled
false/control adapter false/kill switch true; exact-source Production rebuild and
signed closed readiness. Retain deployment IDs and reaper/governance receipts.

The referenced suspension agreement could not be recovered. Both Lab services
are currently running. Proposed explicit close posture, requiring the user's
answer: suspend BOTH isolated Lab MCP and worker after export and verified
settlement, leaving ordinary Sophia services running with Voice Lab gates closed.
No suspension may precede necessary recovery. This is not yet an approved
suspension instruction, and closed gates do not imply permission for indefinite
paid Lab uptime.

## Renewed platform denial after user approval

The controller accepted the clarified Production rebuild method, then its
`mcp__Claude_Browser__browser_batch` action was rejected at
2026-09-21T17:22:34.148Z with category `[Production Deploy]`. The controller
reported this occurred while opening Vercel for step1. No activation was
executed. User task approval is retained; it does not justify bypassing this
separate platform denial. The next external action is the supported controller
permission flow or manual execution of step1, followed by readiness verification
before moving to step2. Do not repeat the generic activation-approval question.
