"""Turn recorded runs into a flat list of failures, each with a text signature.

The signature is what step 4 embeds and clusters, so it keeps the meaning of
an error (which tool, what went wrong) and drops details that differ between
runs (UUIDs, numbers, file names).
"""

import json
import re

UUID_RE = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I)
FILE_RE = re.compile(r"[\w./\\-]*\.[A-Za-z0-9]{1,5}\b")  # names with an extension: a.png, ../secret.txt
NUMBER_RE = re.compile(r"\b\d+\b")


def error_message(raw: str) -> str:
    """Tool errors are stored as '{"error": "..."}' JSON text; LLM errors as plain text."""
    try:
        parsed = json.loads(raw)
    except ValueError:
        return raw
    if isinstance(parsed, dict) and isinstance(parsed.get("error"), str):
        return parsed["error"]
    return raw


def normalize(message: str) -> str:
    message = UUID_RE.sub("<id>", message)
    message = FILE_RE.sub("<file>", message)
    message = NUMBER_RE.sub("<n>", message)
    return message.strip()


def signature(step: dict, message: str) -> str:
    where = f"tool {step['tool']}" if step["type"] == "tool" else "llm"
    return f"{where}: {normalize(message)}"


def run_failures(run: dict, steps: list[dict]) -> list[dict]:
    """Failures in one run: every errored step, plus the run itself if it failed
    without its last step having an error (e.g. it hit the step limit or crashed).

    Replayed steps are skipped: a fork copies its parent's responses, so their
    errors are the parent's failures, already counted there.
    """
    failures = []
    for step in steps:
        if step["error"] is not None and not step["replayed"]:
            message = error_message(step["error"])
            failures.append(failure(run, step, "step_error", message, signature(step, message)))

    last = steps[-1] if steps else None
    if run["status"] == "failed" and (last is None or last["error"] is None):
        failures.append(run_failed(run, last))
    return failures


def run_failed(run: dict, last: dict | None) -> dict:
    if last is None:
        message = "run failed before any step"
    elif last["no_response"]:
        message = f"run failed during {last['type']} step (no response)"
    else:
        message = f"run failed after {last['type']} step"
    sig = message if last is None or last["type"] == "llm" else f"tool {last['tool']}: {message}"
    return failure(run, last, "run_failed", message, sig)


def failure(run: dict, step: dict | None, source: str, message: str, sig: str) -> dict:
    return {
        "run_id": str(run["id"]),
        "run_name": run["name"],
        "idx": step["idx"] if step else None,
        "type": step["type"] if step else None,
        "tool": step["tool"] if step else None,
        "source": source,
        "message": message,
        "signature": sig,
    }
