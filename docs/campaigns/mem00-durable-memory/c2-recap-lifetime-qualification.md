# C2 recap lifetime slice

This frontend-only slice removes persisted recap text/decisions, discards the
old recap cache without deleting unrelated drafts, and binds recap loading and
actions to the authenticated owner/session lifetime. Scope changes hide old
content, invalidate current drafts, and prevent late save/discard responses from
publishing status, success, history or navigation. A→B→A does not revive a pending
action. Local invalidation never claims to undo an already committed server action.

Evidence: complete-page smoke853d66 passed4, including switching owner while the
new response is pending; the broader review suite d4a35c passed40 with2 composed
cases skipped. Those2 cases subsequently ran under the actual SQL/Gateway/Next
driver786c76:41 checks,1,005 canonical candidates,22 Gateway requests, frontend
reporter63c5a3508646b95e426bd130737c5dfdd8f5aa1780a2b4d4a1479362cdf58631,
zero skipped tests and zero provider calls. Disposable database and transport
files were removed. Focused action/store/loader coverage includes delayed save
on owner-cycle/sign-out/unmount and delayed discard success/failure after switch.

This is not production browser/hosted-model acceptance, global history isolation,
or permission to deploy during the shared Voice hold. The wider runtime and
rollout work remains separate. The pilot is not activated by this commit.
