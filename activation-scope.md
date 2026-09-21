# VT00-C5 bounded activation and close scope

Prepared 2026-09-21. Not executed. This scope is for one two-turn installed-plugin
journey, not a full VT00 campaign. Code repair is already deployed. The remaining
configuration deployments are blocked by the deployment controller's recorded
Production Deploy denial. A manual execution or explicit approval through that
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

Save configuration without automatically deploying an unrelated branch. Every
deployment must retain the exact component source above. Keep MCP admission
closed through the product and worker changes.

1. Frontend: `SOPHIA_VOICE_LAB_ENABLED=true`,
   `SOPHIA_VOICE_LAB_CONTROL_ADAPTER_ENABLED=true`,
   `SOPHIA_VOICE_LAB_KILL_SWITCH=false`. Provisioning remains disabled. Redeploy
   and promote the exact frontend source; verify signed readiness and deploy ID.
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
false/control adapter false/kill switch true; exact-source redeploy/promote and
signed closed readiness. Retain deployment IDs and reaper/governance receipts.

The referenced suspension agreement could not be recovered. Both Lab services
are currently running. Proposed explicit close posture, requiring the user's
answer: suspend BOTH isolated Lab MCP and worker after export and verified
settlement, leaving ordinary Sophia services running with Voice Lab gates closed.
No suspension may precede necessary recovery. This is not yet an approved
suspension instruction, and closed gates do not imply permission for indefinite
paid Lab uptime.
