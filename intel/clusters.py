"""Group failures into patterns by clustering their signatures with HDBSCAN.

HDBSCAN fits here because it doesn't need the number of clusters up front and
it leaves one-off failures out (label -1) instead of forcing them into a group.

Two choices that came from trying it on real data:
- Cluster *unique* signatures, then count failures per signature. Identical
  signatures sit at distance 0, which makes their density infinite and drags
  unrelated one-offs into their cluster.
- Every failure still lands in a pattern: a signature HDBSCAN leaves out
  becomes a "single" pattern on its own, so repeated identical failures stay
  visible even when there's too little data to cluster.
"""

from collections import Counter
from typing import Callable

import numpy as np
from sklearn.cluster import HDBSCAN

MIN_CLUSTER_SIZE = 2  # two similar signatures are already a pattern worth showing


def cluster_failures(
    failures: list[dict], embed: Callable[[list[str]], np.ndarray]
) -> list[dict]:
    counts = Counter(f["signature"] for f in failures)
    unique = list(counts)
    labels = cluster_labels(unique, embed)

    groups: dict = {}
    for sig, label in zip(unique, labels):
        key = ("cluster", label) if label >= 0 else ("single", sig)
        groups.setdefault(key, []).append(sig)

    patterns = [pattern(kind, sigs, counts, failures) for (kind, _), sigs in groups.items()]
    patterns.sort(key=lambda p: -p["size"])
    for i, p in enumerate(patterns):
        p["id"] = i
    return patterns


def cluster_labels(signatures: list[str], embed) -> list[int]:
    # HDBSCAN can't find structure in fewer than 3 points: treat them all as one-offs.
    if len(signatures) < 3:
        return [-1] * len(signatures)
    vectors = embed(signatures)
    # Vectors are unit length, so euclidean distance ranks pairs the same as cosine.
    hdb = HDBSCAN(min_cluster_size=MIN_CLUSTER_SIZE, min_samples=1)
    return [int(label) for label in hdb.fit_predict(vectors)]


def pattern(kind: str, sigs: list[str], counts: Counter, failures: list[dict]) -> dict:
    members = [f for f in failures if f["signature"] in sigs]
    by_count = sorted(sigs, key=lambda s: -counts[s])  # stable: ties keep first-seen order
    return {
        "kind": kind,
        "label": by_count[0],
        "size": len(members),
        "run_count": len({f["run_id"] for f in members}),
        "signatures": [{"signature": s, "count": counts[s]} for s in by_count],
        "failures": members,
    }
