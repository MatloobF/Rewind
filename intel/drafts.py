"""Eval drafts: proposed assertions for a finished run, each with a reason.

Nothing here is saved. The user edits the draft in the web UI, and the Node
API validates and stores it (the intel service is read-only). The assertion
shapes must match server/src/assertions.js.

A step is a dict with at least: idx, type ("llm" | "tool"), request, request_hash, error.
"""

import math

from loops import detect_loops

# A succeeded run may take this many times its own step count before the eval
# fails. The model isn't deterministic, so an exact count would be flaky.
STEP_HEADROOM = 1.5


def draft_eval(run: dict, steps: list[dict]) -> dict:
    """Propose an eval for a finished run.

    A run that succeeded gets a "keep this working" test. A run that failed gets
    a regression test for its bug, expected to fail until the bug is fixed.
    """
    if run["status"] == "success":
        suggestions = draft_for_success(steps)
    else:
        suggestions = draft_for_failure(steps)
    return {
        "run_id": str(run["id"]),
        "input_task": input_task(run),
        "suggestions": suggestions,
    }


def input_task(run: dict) -> str:
    """The task is the agent's last argument (`node index.js "sort the files"`).

    That's the sample agent's convention, so fall back to the run name.
    """
    command = run.get("command") or []
    if len(command) > 1 and command[-1].strip():
        return command[-1]
    return run.get("name") or ""


def suggest(assertion: dict, reason: str) -> dict:
    return {"assertion": assertion, "reason": reason}


def draft_for_success(steps: list[dict]) -> list[dict]:
    max_steps = max(1, math.ceil(len(steps) * STEP_HEADROOM))
    suggestions = [
        suggest({"type": "run_status", "status": "success"}, "the run succeeded; it should keep succeeding"),
        suggest(
            {"type": "max_steps", "max": max_steps},
            f"the run took {len(steps)} steps; allow up to {STEP_HEADROOM}x that",
        ),
    ]
    for name in successful_tools(steps):
        suggestions.append(
            suggest({"type": "must_call_tool", "tool": name}, f"the run used {name} successfully")
        )
    errors = tool_errors(steps)
    suggestions.append(
        suggest(
            {"type": "max_tool_errors", "max": len(errors)},
            f"the run had {len(errors)} tool errors; it shouldn't get worse",
        )
    )
    return suggestions


def draft_for_failure(steps: list[dict]) -> list[dict]:
    suggestions = [
        suggest({"type": "run_status", "status": "success"}, "the run failed; a fixed agent should succeed"),
    ]
    errors = tool_errors(steps)
    if errors:
        idxs = ", ".join(str(s["idx"]) for s in errors)
        suggestions.append(
            suggest({"type": "max_tool_errors", "max": 0}, f"tool calls failed at steps {idxs}")
        )
    for name in unknown_tools(steps):
        suggestions.append(
            suggest(
                {"type": "must_not_call_tool", "tool": name},
                f"the run called {name}, which isn't one of the agent's tools",
            )
        )
    loops = detect_loops(steps)
    if loops and len(steps) > 1:
        first = loops[0]["step_idxs"][0]
        suggestions.append(
            suggest(
                {"type": "max_steps", "max": len(steps) - 1},
                f"the run looped from step {first} until it stopped at {len(steps)} steps;"
                " a fixed agent should finish sooner",
            )
        )
    return suggestions


def tool_name(step: dict) -> str | None:
    return (step.get("request") or {}).get("name")


def tool_errors(steps: list[dict]) -> list[dict]:
    return [s for s in steps if s["type"] == "tool" and s.get("error") is not None]


def successful_tools(steps: list[dict]) -> list[str]:
    """Distinct tools called without an error, in order of first use."""
    names = [tool_name(s) for s in steps if s["type"] == "tool" and s.get("error") is None]
    return list(dict.fromkeys(n for n in names if n))


def offered_tools(steps: list[dict]) -> set[str] | None:
    """The tool names the LLM was offered in its requests, or None if no LLM
    request listed any (then unknown tools can't be told apart).
    """
    names = set()
    for s in steps:
        if s["type"] == "llm":
            for t in (s.get("request") or {}).get("tools") or []:
                name = (t.get("function") or {}).get("name")
                if name:
                    names.add(name)
    return names or None


def unknown_tools(steps: list[dict]) -> list[str]:
    """Distinct tools the run called that the LLM was never offered."""
    offered = offered_tools(steps)
    if offered is None:
        return []
    called = [tool_name(s) for s in steps if s["type"] == "tool"]
    return list(dict.fromkeys(n for n in called if n and n not in offered))
