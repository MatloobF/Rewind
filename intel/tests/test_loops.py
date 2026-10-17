from loops import detect_loops, find_repeated_llm_requests, find_tool_cycles


def tool(idx, name, args=None):
    # The hash stands in for the Node request_hash: same name + args -> same hash.
    return {
        "idx": idx,
        "type": "tool",
        "request": {"name": name, "arguments": args or {}},
        "request_hash": f"{name}:{sorted((args or {}).items())}",
    }


def llm(idx, h=None):
    return {"idx": idx, "type": "llm", "request": {}, "request_hash": h or f"llm{idx}"}


def test_no_loop_in_a_normal_run():
    steps = [
        llm(0),
        tool(1, "list_files", {"path": "."}),
        llm(2),
        tool(3, "create_folder", {"path": "images"}),
        tool(4, "create_folder", {"path": "documents"}),
        tool(5, "create_folder", {"path": "audio"}),
        tool(6, "move_file", {"from": "a.png", "to": "images"}),
    ]
    assert detect_loops(steps) == []


def test_same_call_three_times_with_llm_steps_between():
    steps = [
        llm(0),
        tool(1, "list_files", {"path": "."}),
        llm(2),
        tool(3, "list_files", {"path": "."}),
        llm(4),
        tool(5, "list_files", {"path": "."}),
    ]
    assert find_tool_cycles(steps) == [
        {
            "kind": "tool_cycle",
            "tools": ["list_files"],
            "period": 1,
            "repeats": 3,
            "step_idxs": [1, 3, 5],
        }
    ]


def test_two_repeats_is_not_a_loop():
    # One retry is normal; MIN_REPEATS is 3.
    steps = [tool(0, "list_files", {"path": "."}), tool(1, "list_files", {"path": "."})]
    assert find_tool_cycles(steps) == []


def test_alternating_cycle_found_once_as_period_two():
    a = lambda i: tool(i, "list_files", {"path": "."})
    b = lambda i: tool(i, "read_file", {"path": "x.txt"})
    steps = [a(0), b(1), a(2), b(3), a(4), b(5), a(6)]
    loops = find_tool_cycles(steps)
    assert len(loops) == 1
    assert loops[0]["period"] == 2
    assert loops[0]["tools"] == ["list_files", "read_file"]
    assert loops[0]["repeats"] == 3
    assert loops[0]["step_idxs"] == [0, 1, 2, 3, 4, 5]


def test_a_run_of_one_call_is_not_reported_as_period_two():
    steps = [tool(i, "list_files", {"path": "."}) for i in range(6)]
    loops = find_tool_cycles(steps)
    assert [l["period"] for l in loops] == [1]
    assert loops[0]["repeats"] == 6


def test_same_tool_different_arguments_is_not_a_loop():
    steps = [tool(i, "move_file", {"from": f"f{i}", "to": "docs"}) for i in range(5)]
    assert find_tool_cycles(steps) == []


def test_repeated_llm_request():
    steps = [llm(0, "same"), tool(1, "list_files"), llm(2, "same"), llm(3, "other")]
    assert find_repeated_llm_requests(steps) == [
        {"kind": "repeated_llm_request", "repeats": 2, "step_idxs": [0, 2]}
    ]


def test_sdk_retries_after_errors_are_not_a_loop():
    # Seen in a real run: three upstream timeouts, same request each time.
    steps = [llm(i, "same") | {"error": "upstream request failed: timeout"} for i in range(3)]
    assert find_repeated_llm_requests(steps) == []


def test_errored_tool_calls_still_count_as_a_cycle():
    # The MCP proxy never retries, so a repeated failing call is the agent's choice.
    steps = [tool(i, "move_file", {"from": "a", "to": "b"}) | {"error": "ENOENT"} for i in range(3)]
    assert len(find_tool_cycles(steps)) == 1


def test_empty_run():
    assert detect_loops([]) == []
