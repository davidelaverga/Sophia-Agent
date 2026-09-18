"""The two non-owner service lanes, and what they may not reach.

Three of the four callers that still bypassed Gateway authentication cannot
carry a principal at all: post-retention Builder cleanup and the global reaper
run *after* the raw identity has been erased -- that is the Voice Lab retention
obligation they implement -- and the fourth, deck-quality dispatch, belongs to a
deck rather than to a person. The remaining one carries the Voice Lab test
principal, for which `_scope` refuses to mint a token on purpose.

So these lanes exist because owner scoping is structurally impossible there, not
because it was inconvenient. Everything below is about keeping that narrow: the
allow-lists, the routes they must NOT reach, and the metadata filters that
confine each lane to its own threads.

None of this is installed. `langgraph.json` still has no `auth` entry and
`test_render_config` still asserts that; these are the primitives the
coordinated install would switch on, not the switch.
"""

from uuid import uuid4

import pytest

from deerflow.sophia.langgraph_service_auth import (
    DECK_QUALITY_OWNER,
    MAINTENANCE_OWNER,
    READINESS_OWNER,
    LangGraphServiceAuthError,
    mint_service_authorization,
    verify_service_authorization,
)

THREAD = str(uuid4())
RUN = str(uuid4())


@pytest.fixture(autouse=True)
def key(monkeypatch):
    monkeypatch.setenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET", "synthetic-service-key-" * 3)
    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "voice-lab-test")


def _round_trip(owner, method, path):
    value = mint_service_authorization(owner_id=owner, method=method, path=path, now=100)
    return verify_service_authorization(value, method=method, path=path, now=101)


# --- what each lane may reach ------------------------------------------------


@pytest.mark.parametrize("method,path", [
    ("POST", "/threads/search"),
    ("GET", f"/threads/{THREAD}"),
    ("GET", f"/threads/{THREAD}/runs"),
    ("GET", f"/threads/{THREAD}/runs/{RUN}"),
    ("POST", f"/threads/{THREAD}/runs/{RUN}/cancel"),
    ("DELETE", f"/threads/{THREAD}"),
])
def test_maintenance_lane_reaches_exactly_the_cleanup_routes(method, path):
    claims = _round_trip(MAINTENANCE_OWNER, method, path)
    assert claims["scope"] == "maintenance"
    assert claims["sub"] == MAINTENANCE_OWNER


@pytest.mark.parametrize("method,path", [
    ("POST", "/threads"),
    ("POST", f"/threads/{THREAD}/runs"),
    ("GET", f"/threads/{THREAD}/runs"),
])
def test_deck_quality_lane_reaches_exactly_its_dispatch_routes(method, path):
    assert _round_trip(DECK_QUALITY_OWNER, method, path)["scope"] == "deck_quality"


# --- what they may not ------------------------------------------------------


@pytest.mark.parametrize("method,path", [
    # Creating a run is the whole memory/source/model surface. The retention
    # lane must never have it.
    ("POST", f"/threads/{THREAD}/runs"),
    ("POST", f"/threads/{THREAD}/runs/stream"),
    ("POST", "/threads"),
    # State, history and copy are cross-owner CONTENT. The owner lane may reach
    # them; a lane that is not owner-scoped may not.
    ("POST", f"/threads/{THREAD}/state"),
    ("GET", f"/threads/{THREAD}/state"),
    ("GET", f"/threads/{THREAD}/state/checkpoint"),
    ("GET", f"/threads/{THREAD}/history"),
    ("POST", f"/threads/{THREAD}/copy"),
    # And nothing outside threads at all.
    ("POST", "/assistants/search"),
    ("GET", "/store/items"),
    ("POST", "/crons"),
])
def test_maintenance_lane_cannot_mint_anything_else(method, path):
    with pytest.raises(LangGraphServiceAuthError):
        mint_service_authorization(owner_id=MAINTENANCE_OWNER, method=method, path=path, now=100)


@pytest.mark.parametrize("method,path", [
    ("DELETE", f"/threads/{THREAD}"),
    ("POST", "/threads/search"),
    ("GET", f"/threads/{THREAD}/state"),
    ("GET", f"/threads/{THREAD}"),
])
def test_deck_quality_lane_cannot_delete_search_or_read_state(method, path):
    with pytest.raises(LangGraphServiceAuthError):
        mint_service_authorization(owner_id=DECK_QUALITY_OWNER, method=method, path=path, now=100)


def test_a_lane_token_cannot_be_replayed_on_another_lanes_route():
    """One lane's credential is not the other's, even for a shared route."""
    value = mint_service_authorization(owner_id=DECK_QUALITY_OWNER, method="POST",
                                       path=f"/threads/{THREAD}/runs", now=100)
    with pytest.raises(LangGraphServiceAuthError):
        verify_service_authorization(value, method="DELETE", path=f"/threads/{THREAD}", now=101)
    maintenance = mint_service_authorization(owner_id=MAINTENANCE_OWNER, method="DELETE",
                                             path=f"/threads/{THREAD}", now=100)
    with pytest.raises(LangGraphServiceAuthError):
        verify_service_authorization(maintenance, method="POST", path=f"/threads/{THREAD}/runs", now=101)


def test_the_voice_lab_principal_refusal_stays_absolute():
    """The new lanes must not become a way around the isolation rule."""
    for method, path in [("DELETE", f"/threads/{THREAD}"), ("POST", "/threads/search")]:
        with pytest.raises(LangGraphServiceAuthError):
            mint_service_authorization(owner_id="voice-lab-test", method=method, path=path, now=100)


def test_the_readiness_lane_is_unchanged():
    assert _round_trip(READINESS_OWNER, "POST", "/assistants/search")["scope"] == "readiness"
    with pytest.raises(LangGraphServiceAuthError):
        mint_service_authorization(owner_id=READINESS_OWNER, method="DELETE",
                                   path=f"/threads/{THREAD}", now=100)


def test_an_ordinary_owner_is_unchanged():
    claims = _round_trip("owner-a", "POST", f"/threads/{THREAD}/state")
    assert claims["scope"] == "owner"


# --- the client-side lane ----------------------------------------------------


def test_service_scope_signs_as_the_lane_and_resets(monkeypatch):
    import asyncio

    import httpx

    from deerflow.sophia.langgraph_client_auth import (
        OwnerScopedAuth,
        _owner,
        langgraph_service_scope,
    )

    observed = []

    def handler(request):
        claims = verify_service_authorization(request.headers["Authorization"],
                                              method=request.method, path=request.url.path)
        observed.append((claims["sub"], claims["scope"]))
        return httpx.Response(200, json={})

    async def run():
        async with httpx.AsyncClient(base_url="https://runtime.invalid", auth=OwnerScopedAuth(),
                                     transport=httpx.MockTransport(handler)) as client:
            with langgraph_service_scope("maintenance"):
                await client.post("/threads/search")
            with langgraph_service_scope("deck_quality"):
                await client.post("/threads")
    asyncio.run(run())
    assert observed == [(MAINTENANCE_OWNER, "maintenance"), (DECK_QUALITY_OWNER, "deck_quality")]
    assert _owner.get() is None


def test_service_scope_refuses_an_unknown_lane():
    from deerflow.sophia.langgraph_client_auth import langgraph_service_scope

    with pytest.raises(LangGraphServiceAuthError):
        with langgraph_service_scope("anything-else"):
            pass


# --- the runtime policy's own confinement ------------------------------------


class _Ctx:
    def __init__(self, permissions, identity="whoever"):
        self.permissions = permissions
        self.user = type("U", (), {"identity": identity})()


def test_each_lane_is_confined_to_its_own_threads_by_filter():
    import asyncio

    from deerflow.sophia import langgraph_auth as policy

    maintenance = asyncio.run(policy.owned_thread(
        _Ctx([policy.MAINTENANCE_PERMISSION]), {}))
    # The SERVER-issued label, not the client-suppliable `synthetic` boolean.
    assert maintenance == {policy.MAINTENANCE_KEY: True}
    assert policy.MAINTENANCE_KEY != policy.SYNTHETIC_KEY

    quality = asyncio.run(policy.owned_thread(
        _Ctx([policy.DECK_QUALITY_PERMISSION]), {}))
    assert quality == {policy.DECK_QUALITY_KEY: True}


def test_the_maintenance_lane_cannot_create_a_thread_or_a_run():
    import asyncio

    from langgraph_sdk import Auth

    from deerflow.sophia import langgraph_auth as policy

    for handler in (policy.create_thread, policy.create_run):
        with pytest.raises(Auth.exceptions.HTTPException):
            asyncio.run(handler(_Ctx([policy.MAINTENANCE_PERMISSION]), {}))


@pytest.mark.parametrize("key", ["OWNER_KEY", "MAINTENANCE_KEY", "DECK_QUALITY_KEY"])
def test_a_client_cannot_label_its_own_thread_into_a_lane(key):
    from langgraph_sdk import Auth

    from deerflow.sophia import langgraph_auth as policy

    with pytest.raises(Auth.exceptions.HTTPException):
        policy._reject_owner_metadata({"metadata": {getattr(policy, key): True}})


def test_a_service_principal_can_never_be_an_owner():
    """Even if a real account somehow carried one of the reserved names."""
    from langgraph_sdk import Auth

    from deerflow.sophia import langgraph_auth as policy

    for name in (MAINTENANCE_OWNER, DECK_QUALITY_OWNER, READINESS_OWNER):
        with pytest.raises(Auth.exceptions.HTTPException):
            policy._owner(_Ctx([policy.USER_PERMISSION], identity=name))
