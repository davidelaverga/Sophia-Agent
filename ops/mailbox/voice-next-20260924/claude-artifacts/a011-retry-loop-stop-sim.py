"""Emulate PostgREST/hasql: retry the whole transaction on SQLSTATE 40001 forever.
Four looping clients; the migration is applied by another session mid-loop."""
import subprocess, sys, threading, time
import psycopg
DSN, MIG = sys.argv[1], sys.argv[2]
state = {}
def looper(i):
    retries, t0 = 0, time.monotonic()
    with psycopg.connect(DSN) as c:
        while True:
            try:
                c.execute("select public.sophia_memory_authorize_extraction_dispatch('u',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'x','y')")
                c.commit(); state[i] = ("success", retries); return
            except psycopg.errors.SerializationFailure:
                c.rollback(); retries += 1
            except psycopg.Error as e:
                c.rollback(); state[i] = (e.sqlstate, e.diag.message_primary, retries, time.monotonic()); return
threads = [threading.Thread(target=looper, args=(i,)) for i in range(4)]
start = time.monotonic(); [t.start() for t in threads]
time.sleep(2.0)
t_apply = time.monotonic()
r = subprocess.run(["psql", "-v", "ON_ERROR_STOP=1", "-q", DSN, "-f", MIG], capture_output=True, text=True)
t_commit = time.monotonic()
print("migration rc", r.returncode, r.stderr.strip()[:200])
[t.join(timeout=10) for t in threads]
for i, s in sorted(state.items()):
    print(f"client {i}: sqlstate={s[0]} msg={s[1]} retries_before_stop={s[2]} stopped_{(s[3]-t_commit)*1000:.0f}ms_after_commit")
total = sum(s[2] for s in state.values())
print(f"retry rate before migration ~{total/(t_apply-start):.0f}/s across 4 clients; all stopped: {len(state)==4 and all(t.is_alive() is False for t in threads)}")
