from drafts import draft_eval, input_task

OFFERED = ["list_files", "read_file", "create_folder", "move_file"]


def llm(idx, tools=OFFERED):
    request = {"tools": [{"type": "function", "function": {"name": n}} for n in tools]}
    return {"idx": idx, "type": "llm", "request": request, "request_hash": f"llm{idx}", "error": None}


def tool(idx, name, args=None, error=None):
    # Same name + args -> same hash, like the Node request_hash.
    return {
        "idx": idx,
        "type": "tool",
        "request": {"name": name, "arguments": args or {}},
        "request_hash": f"{name}:{sorted((args or {}).items())}",
        "error": error,
    }


def run(status, command=("node", "examples/agent/index.js", "sort the files"), name="r"):
    return {"id": "11111111-1111-1111-1111-111111111111", "name": name, "status": status, "command": list(command)}


def assertions(draft):
    return [s["assertion"] for s in draft["suggestions"]]


def test_every_suggestion_has_a_reason():
    draft = draft_eval(run("success"), [llm(0), tool(1, "list_files"), llm(2)])
    assert draft["suggestions"]
    assert all(isinstance(s["reason"], str) and s["reason"] for s in draft["suggestions"])


def test_succeeded_run_gets_a_keep_working_test():
    steps = [
        llm(0),
        tool(1, "list_files", {"path": "."}),
        llm(2),
        tool(3, "create_folder", {"path": "images"}),
        llm(4),
        tool(5, "move_file", {"from": "a.png", "to": "images"}, error='{"error":"Already exists"}'),
        llm(6),
        tool(7, "move_file", {"from": "b.png", "to": "images"}),
        llm(8),
    ]
    draft = draft_eval(run("success"), steps)
    assert draft["run_id"] == "11111111-1111-1111-1111-111111111111"
    assert draft["input_task"] == "sort the files"
    assert assertions(draft) == [
        {"type": "run_status", "status": "success"},
        {"type": "max_steps", "max": 14},  # ceil(9 * 1.5)
        {"type": "must_call_tool", "tool": "list_files"},
        {"type": "must_call_tool", "tool": "create_folder"},
        {"type": "must_call_tool", "tool": "move_file"},
        {"type": "max_tool_errors", "max": 1},
    ]


def test_tool_that_only_failed_is_not_required():
    steps = [llm(0), tool(1, "read_file", {"path": "../x"}, error="escape"), llm(2)]
    draft = draft_eval(run("success"), steps)
    assert {"type": "must_call_tool", "tool": "read_file"} not in assertions(draft)


def test_failed_run_gets_a_regression_test():
    steps = [
        llm(0),
        tool(1, "rename_file", {"from": "a"}, error='{"error":"Unknown tool: rename_file"}'),
        llm(2),
        tool(3, "read_file", {"path": "../secret.txt"}, error="escape"),
        llm(4),
    ]
    draft = draft_eval(run("failed"), steps)
    assert assertions(draft) == [
        {"type": "run_status", "status": "success"},
        {"type": "max_tool_errors", "max": 0},
        {"type": "must_not_call_tool", "tool": "rename_file"},
    ]
    assert "steps 1, 3" in draft["suggestions"][1]["reason"]


def test_stuck_run_gets_max_steps_below_where_it_stopped():
    steps = []
    for i in range(5):
        steps += [llm(2 * i), tool(2 * i + 1, "list_files", {"path": "."})]
    draft = draft_eval(run("failed"), steps)
    assert {"type": "max_steps", "max": 9} in assertions(draft)
    assert "from step 1" in draft["suggestions"][-1]["reason"]


def test_failed_run_without_a_loop_gets_no_max_steps():
    draft = draft_eval(run("failed"), [llm(0), tool(1, "list_files"), llm(2)])
    assert all(a["type"] != "max_steps" for a in assertions(draft))


def test_unknown_tools_need_an_offered_tool_list():
    # No LLM request listed tools, so nothing can be called unknown.
    steps = [llm(0, tools=[]), tool(1, "rename_file", error="x")]
    draft = draft_eval(run("failed"), steps)
    assert all(a["type"] != "must_not_call_tool" for a in assertions(draft))


def test_run_with_no_steps():
    assert assertions(draft_eval(run("success"), [])) == [
        {"type": "run_status", "status": "success"},
        {"type": "max_steps", "max": 1},
        {"type": "max_tool_errors", "max": 0},
    ]
    assert assertions(draft_eval(run("failed"), [])) == [{"type": "run_status", "status": "success"}]


def test_input_task_falls_back_to_the_run_name():
    assert input_task(run("success", command=["my-agent"], name="nightly")) == "nightly"
    assert input_task(run("success", command=["node", "a.js", "  "], name="nightly")) == "nightly"
    assert input_task({"command": None, "name": None}) == ""
