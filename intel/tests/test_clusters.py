import numpy as np

from clusters import cluster_failures

# Hand-picked vectors stand in for the model: two tight families and one outlier.
VECTORS = {
    "tool move_file: Already exists: images": [1.0, 0.02, 0.0],
    "tool move_file: Already exists: documents": [1.0, 0.0, 0.03],
    "tool move_file: Already exists: notes": [1.0, 0.03, 0.02],
    "llm: upstream request failed: TIMEOUT": [0.0, 1.0, 0.02],
    "llm: upstream request failed: ECONNREFUSED": [0.02, 1.0, 0.0],
    "llm: upstream request failed: 502": [0.03, 1.0, 0.03],
    "tool delete_everything: Unknown tool": [0.0, 0.0, 1.0],
}


def fake_embed(texts):
    v = np.array([VECTORS[t] for t in texts])
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def failure(sig, run="r1", idx=0):
    return {"run_id": run, "idx": idx, "signature": sig, "message": sig}


def test_similar_signatures_form_clusters_and_outliers_stay_single():
    failures = [failure(s, idx=i) for i, s in enumerate(VECTORS)]
    patterns = cluster_failures(failures, fake_embed)
    kinds = sorted((p["kind"], p["size"]) for p in patterns)
    assert kinds == [("cluster", 3), ("cluster", 3), ("single", 1)]
    single = next(p for p in patterns if p["kind"] == "single")
    assert single["label"] == "tool delete_everything: Unknown tool"


def test_identical_failures_are_counted_not_reclustered():
    # Three copies of one timeout plus the families: still one pattern per family.
    failures = [failure(s, idx=i) for i, s in enumerate(VECTORS)]
    failures += [failure("llm: upstream request failed: TIMEOUT", run="r2", idx=9)] * 2
    patterns = cluster_failures(failures, fake_embed)
    llm = next(p for p in patterns if p["label"].startswith("llm"))
    assert llm["size"] == 5
    assert llm["run_count"] == 2
    assert llm["label"] == "llm: upstream request failed: TIMEOUT"  # the most common signature
    assert llm["signatures"][0] == {"signature": "llm: upstream request failed: TIMEOUT", "count": 3}


def test_patterns_are_sorted_by_size_with_ids():
    failures = [failure(s) for s in VECTORS] + [failure("tool move_file: Already exists: images")] * 4
    patterns = cluster_failures(failures, fake_embed)
    assert [p["id"] for p in patterns] == list(range(len(patterns)))
    sizes = [p["size"] for p in patterns]
    assert sizes == sorted(sizes, reverse=True)
    assert patterns[0]["label"] == "tool move_file: Already exists: images"


def test_too_few_signatures_skip_clustering():
    def must_not_embed(texts):
        raise AssertionError("embed called with fewer than 3 signatures")

    failures = [failure("llm: upstream request failed: TIMEOUT")] * 3 + [
        failure("tool delete_everything: Unknown tool")
    ]
    patterns = cluster_failures(failures, must_not_embed)
    assert [(p["kind"], p["size"]) for p in patterns] == [("single", 3), ("single", 1)]


def test_no_failures():
    assert cluster_failures([], fake_embed) == []


def test_every_failure_lands_in_exactly_one_pattern():
    failures = [failure(s, idx=i) for i, s in enumerate(VECTORS)]
    patterns = cluster_failures(failures, fake_embed)
    assert sum(p["size"] for p in patterns) == len(failures)
