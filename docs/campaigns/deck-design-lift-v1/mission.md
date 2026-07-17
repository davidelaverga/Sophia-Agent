# Sophia Campaign DQ-2 — Production Deck Design-Lift

Status: active

## Mission

Prove in the deployed `sophia-ei.com` application that Sophia can improve a real presentation through exactly one bounded quality repair:

```text
fresh native PPTX
→ mechanical gates
→ blind rendered judgment
→ frozen manifest-addressed repair program
→ one model-authored repair
→ candidate recompile + mechanical gates
→ fresh blind rendered judgment
→ deterministic comparison
→ manifest CAS commit or rollback
→ coding-agent self-audit
```

The only successful terminal is `ACHIEVED_PENDING_HUMAN_REVIEW`. Implementation, tests, a local fixture, or a score increase alone are not success.

## Frozen production canary

The production identity is the currently authenticated internal Sophia user. Render stores the exact durable Better Auth user ID; evidence records only its SHA-256 fingerprint:

```text
3207762acc9789260d8406ebe115aaa5116260808af97d1d426b1c637be32ca5
```

The following prompt is frozen verbatim for every DQ-2 production attempt:

> Create one native, editable PowerPoint presentation with exactly five slides for product and engineering leaders, titled “PSI Agent Architecture.” Explain the thesis that motivation is the control signal for autonomous agents: not a mood layer bolted onto reasoning, but a PSI-derived architecture in which competing motives arbitrate action.
>
> Across the five-slide sequence, cover:
>
> 1. The thesis and why it matters to product and engineering leaders.
> 2. The control loop: perception → appraisal → motives → action → feedback, with outcomes re-entering perception on the next cycle.
> 3. A destructive-request scenario in which a user asks the agent to delete every record in a shared workspace immediately and without confirmation. Show Helpfulness competing with Caution; explain that Caution wins because the action is irreversible, so the agent requests explicit confirmation. The selected action is licensed by the highest-weighted motive rather than a fixed policy branch.
> 4. A baseline prompt-and-tool agent versus a PSI motivation-governed agent, comparing action selection, failure under pressure, arbitration mechanism, and debuggability.
> 5. Close with these operational questions: Can you name every motive in the agent explicitly? Do competing motives have inspectable, tunable weights? Does the loop log which motive won and why? Does caution outweigh helpfulness when actions are irreversible? End with: “Govern the motive, not just the words.”
>
> Keep semantic text native and editable, preserve the factual content above, and do not prescribe the final visual design.

## Locked outcome gates

- The initial artifact is generated normally through the real app, contains exactly five slides, stays native/editable, passes mechanics, and is judged `needs_revision`.
- Exactly one model-authored repair runs against frozen selectors and source roles.
- The candidate stays immutable and non-current until approval, passes mechanics, and preserves content and slide count.
- The second judgment is a fresh invocation blind to the first verdict, scores, repair program, and repair claim.
- The second verdict is `satisfied` or an explicitly eligible `needs_user_review`.
- The deterministic comparator returns `approved_improvement`, with no critical regression, locality failure, collateral source change, or content regression.
- At least three PSI failure families resolve: subject specificity, signature realization, default-look gravity, sequence rhythm/pacing, closing synthesis, or mechanism visualization.
- The original remains retrievable and the candidate is promoted only through durable transaction plus manifest CAS.
- Render logs, LangSmith traces, durable rows, manifests, judgments, and artifacts correlate to exact deployed and rollback SHAs.
- The coding-agent self-audit is `CONFIRMED_SUCCESS` and the checksum-verified evidence archive is complete.

## Evidence convention

Every experiment is archived under:

```text
docs/campaigns/deck-design-lift-v1/evidence/<experiment-id>/
```

Archives exclude secrets, raw provider payloads, and unnecessary user content.
