"""Dedicated structural-export session with content-free cleanup failure state."""
from requests import Session


class OwnedTraceSession(Session):
    def __init__(self):
        super().__init__()
        self.cleanup_attempted = False
        self.cleanup_failed = False

    def close(self):
        # The installed SDK catches Session.close failures and logs their raw
        # messages. Retain only a boolean and continue closing every distinct
        # adapter; the exporter reports the gap without an exception body.
        self.cleanup_attempted = True
        seen = set()
        for adapter in self.adapters.values():
            if id(adapter) in seen:
                continue
            seen.add(id(adapter))
            try:
                adapter.close()
            except Exception:
                self.cleanup_failed = True
