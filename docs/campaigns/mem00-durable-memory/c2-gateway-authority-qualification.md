# C2 Gateway authority bridge

Parent: 1d4cab3d9d9a404515b61bf04b2a4e7f369b6577.

This slice mounts authenticated subject and owner-authority observations for the
text runtime's existing bearer token, plus a narrowly scoped internal service
token broker. Subject resolution does not accept development bypass or a cached
request-state identity. Memory-authority responses are observations only, not
source admission, approval, or model permission. Unknown authority denies.

The broker requires the existing Voice internal credential; a user bearer cannot
mint service tokens. The token protocol and principal restrictions are the
previously published service-auth primitive. This commit neither activates
LangGraph's receiving policy nor configures a caller to use the broker.

Gateway request middleware binds the verified bearer owner to task-local SDK
context. Anonymous and development-bypass requests clear that context; concurrent
requests cannot borrow each other's owner. Signed Builder webhooks separately
establish their already-authenticated event owner.

The tests cover subject-only/no-store responses, invalid bearer and reserved
principal rejection, exact owner-authority responses and outages, broker credential
and scope restrictions, plus real Gateway middleware concurrency and scope reset.
Tests of the unfinished LangGraph receiving policy remain outside this slice.

Qualification: 821355 passed all28 cases after separating route tests from runtime
policy tests. The archived candidate passed31 route/mount/ownership cases in
390582, with explicit archived imports; 10 unrelated readiness cases were
deselected and 2 warnings remain. The full working-tree Gateway/bridge/event suite
previously passed53 in d054ab; do not confuse it with the archived selection.

No deployment, migration, new secret, Mem0 change, consumer activation or pilot
success is claimed. Serving ownership policy, internal caller compatibility,
durable no-legacy rollback and the hosted C2 journey remain required.
