# C2 worker owner propagation

Parent: 65e50bc43f9f623690dcbd2416c5aa5965264575.

The channel manager and companion wakeup worker use the existing owner-scoped
LangGraph SDK adapter. Channel ownership is established after the existing
canonical channel-user binding. Completion wakeup ownership comes from the
trusted caller's event. Neither an owner context nor a service token approves
source text, memory inheritance, or a model dispatch.

Each invocation enters and resets its own context; shared clients do not retain
one owner's credential. Exception handlers run after the failed invocation's
scope exits. Tests cover concurrent event/channel owners, command and chat paths,
and context reset after errors, alongside existing worker/channel regressions.
The new context tests use synthetic handler/SDK seams; hosted authorization and
final model admission remain separate checks.

No new task, credential, service flag, schema, consumer activation or deployment
is introduced. Receiving runtime policy and the C2 model/Builder completion
requirements are not established by this slice.

Qualification: ecde62 passed156 in the working environment. d666bb passed156
against the archived candidate with explicit archived import assertions and no
deselections (5 warnings). The dependency environment remains the frozen uv
Python3.12 workspace environment; no production requests were made by these tests.
