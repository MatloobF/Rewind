"""Sentence embeddings with all-MiniLM-L6-v2, running locally on CPU (free, Rule 11).

The model (~90 MB) is downloaded on first use into the Hugging Face cache.
torch is only imported inside get_model(), which the server calls in a startup
thread (main.py), so /health and the tests never pay for importing it.
"""

import os
import threading

import numpy as np

# Windows without Developer Mode can't symlink; the cache copies files instead. Harmless.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

MODEL_NAME = "all-MiniLM-L6-v2"
_cache: dict[str, np.ndarray] = {}  # signature -> vector; signatures repeat a lot
_model = None
_model_lock = threading.Lock()  # main.py warms the model in a thread; a request may arrive mid-load


def get_model():
    global _model
    with _model_lock:
        if _model is None:
            from sentence_transformers import SentenceTransformer

            _model = SentenceTransformer(MODEL_NAME, device="cpu")
        return _model


def embed(texts: list[str]) -> np.ndarray:
    """Unit-length vectors, one row per text."""
    missing = [t for t in dict.fromkeys(texts) if t not in _cache]
    if missing:
        vectors = get_model().encode(missing, normalize_embeddings=True)
        _cache.update(zip(missing, vectors))
    return np.array([_cache[t] for t in texts])
