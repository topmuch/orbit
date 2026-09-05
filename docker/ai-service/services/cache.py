"""Orbit — cache mémoire des réponses IA identiques.

Équivalent Python de src/cache.ts (mini-service bun) : dictionnaire ordonné,
200 entrées max, TTL 10 min, compteur de hits pour /health.
Les requêtes /chat ne passent pas par ce cache (réponses uniques par nature).
"""

import os
import time
from collections import OrderedDict

_TTL_S = float(os.getenv("AI_CACHE_TTL_MS", "600000")) / 1000.0
_MAX_ENTRIES = 200
_store: "OrderedDict[str, tuple]" = OrderedDict()
_hits = 0


def cache_get(key: str):
    entry = _store.get(key)
    if entry is None:
        return None
    value, expires_at = entry
    if expires_at <= time.time():
        _store.pop(key, None)
        return None
    global _hits
    _hits += 1
    return value


def cache_set(key: str, value) -> None:
    if len(_store) >= _MAX_ENTRIES:
        _store.popitem(last=False)  # éviction du plus ancien (FIFO)
    _store[key] = (value, time.time() + _TTL_S)


def cache_stats() -> dict:
    now = time.time()
    for key in [k for k, (_, exp) in _store.items() if exp <= now]:
        _store.pop(key, None)
    return {"size": len(_store), "hits": _hits}
