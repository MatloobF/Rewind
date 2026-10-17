"""Loop detection over a run's steps.

A step is a dict with at least: idx, type ("llm" | "tool"), request, request_hash.
Signatures reuse the Node server's request_hash instead of re-hashing here, so
there is still only one hashRequest() (two tool calls share a hash exactly when
they have the same tool name and arguments).
"""

MAX_PERIOD = 3  # look for cycles of 1, 2 or 3 tool calls
MIN_REPEATS = 3  # a cycle must repeat at least this many times in a row


def detect_loops(steps: list[dict]) -> list[dict]:
    return find_tool_cycles(steps) + find_repeated_llm_requests(steps)


def find_tool_cycles(
    steps: list[dict], max_period: int = MAX_PERIOD, min_repeats: int = MIN_REPEATS
) -> list[dict]:
    """Find tool calls repeating back to back: A A A, or A B A B A B.

    LLM steps in between are ignored, because their requests carry the growing
    message history and so never repeat even when the agent is stuck.
    """
    tools = [s for s in steps if s["type"] == "tool"]
    sigs = [s["request_hash"] for s in tools]
    loops = []
    for period in range(1, max_period + 1):
        i = 0
        while i + period <= len(sigs):
            repeats = count_repeats(sigs, i, period)
            cycle = sigs[i : i + period]
            if repeats >= min_repeats and is_primitive(cycle):
                matched = tools[i : i + repeats * period]
                loops.append(
                    {
                        "kind": "tool_cycle",
                        "tools": [s["request"].get("name") for s in matched[:period]],
                        "period": period,
                        "repeats": repeats,
                        "step_idxs": [s["idx"] for s in matched],
                    }
                )
                i += repeats * period  # skip past it so A B A B isn't found again as B A B A
            else:
                i += 1
    return loops


def count_repeats(sigs: list, start: int, period: int) -> int:
    """How many whole copies of sigs[start:start+period] follow back to back."""
    end = start + period
    while end < len(sigs) and sigs[end] == sigs[end - period]:
        end += 1
    return (end - start) // period


def is_primitive(cycle: list) -> bool:
    """Reject cycles that are just a shorter cycle repeated (A A is period 1, not 2).

    For periods up to 3 (both prime) a cycle is a smaller one repeated only when
    all its elements are equal.
    """
    return len(cycle) == 1 or len(set(cycle)) > 1


def find_repeated_llm_requests(steps: list[dict]) -> list[dict]:
    """The exact same LLM request sent more than once: no progress in between.

    Errored LLM steps are skipped: the OpenAI SDK retries a failed call with the
    identical request (max_retries defaults to 2), and that's a transport retry,
    not the agent repeating itself. Those show up as failures instead.
    """
    by_hash: dict[str, list[int]] = {}
    for s in steps:
        if s["type"] == "llm" and s.get("error") is None:
            by_hash.setdefault(s["request_hash"], []).append(s["idx"])
    return [
        {"kind": "repeated_llm_request", "repeats": len(idxs), "step_idxs": idxs}
        for idxs in by_hash.values()
        if len(idxs) > 1
    ]
