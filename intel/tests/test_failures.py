from failures import error_message, normalize, run_failures

RUN = {"id": "e7cfcdd1-0000-0000-0000-000000000000", "name": "test", "status": "success"}


def step(idx, type="tool", tool="move_file", error=None, replayed=False, no_response=False):
    return {
        "idx": idx,
        "type": type,
        "tool": tool if type == "tool" else None,
        "error": error,
        "replayed": replayed,
        "no_response": no_response,
    }


def test_error_message_unwraps_tool_error_json():
    assert error_message('{"error":"Unknown tool: x"}') == "Unknown tool: x"


def test_error_message_keeps_plain_text():
    assert error_message("upstream request failed: TIMEOUT") == "upstream request failed: TIMEOUT"
    assert error_message('["not", "an", "object"]') == '["not", "an", "object"]'


def test_normalize_drops_run_specific_details():
    assert normalize("Path escapes the sandbox: ../secret.txt") == "Path escapes the sandbox: <file>"
    assert normalize("run 04c8166c-1234-4abc-9def-0123456789ab took 305839 ms") == "run <id> took <n> ms"


def test_errored_steps_become_failures_with_signatures():
    steps = [
        step(0, type="llm"),
        step(1, error='{"error":"Already exists, not overwriting: images"}'),
        step(2, type="llm", error="upstream request failed: UND_ERR_HEADERS_TIMEOUT"),
    ]
    failures = run_failures(RUN, steps)
    assert [f["signature"] for f in failures] == [
        "Already exists, not overwriting: <value>",
        "upstream request failed: UND_ERR_HEADERS_TIMEOUT",
    ]
    assert failures[0]["tool"] == "move_file"  # kept for display, just not in the signature
    assert failures[0]["idx"] == 1
    assert failures[0]["message"] == "Already exists, not overwriting: images"
    assert failures[0]["source"] == "step_error"


def test_tool_error_value_is_dropped_but_llm_error_detail_is_kept():
    steps = [
        step(0, tool="read_file", error='{"error":"Unknown tool: rename_file"}'),
        step(1, type="llm", error="upstream HTTP 404: model not found"),
    ]
    assert [f["signature"] for f in run_failures(RUN, steps)] == [
        "Unknown tool: <value>",
        "upstream HTTP <n>: model not found",
    ]


def test_replayed_errors_belong_to_the_parent():
    steps = [step(0, error='{"error":"boom"}', replayed=True), step(1)]
    assert run_failures(RUN, steps) == []


def test_failed_run_whose_last_step_errored_is_not_counted_twice():
    run = RUN | {"status": "failed"}
    steps = [step(0, type="llm", error="upstream request failed: TIMEOUT")]
    assert [f["source"] for f in run_failures(run, steps)] == ["step_error"]


def test_failed_run_without_a_step_error_gets_a_run_failure():
    run = RUN | {"status": "failed"}
    failures = run_failures(run, [step(0, type="llm"), step(1, tool="list_files")])
    assert len(failures) == 1
    assert failures[0]["source"] == "run_failed"
    assert failures[0]["idx"] == 1
    assert failures[0]["signature"] == "run failed after tool step"


def test_failed_run_that_died_mid_call():
    run = RUN | {"status": "failed"}
    failures = run_failures(run, [step(0, type="llm", no_response=True)])
    assert failures[0]["signature"] == "run failed during llm step (no response)"


def test_failed_run_with_no_steps():
    run = RUN | {"status": "failed"}
    failures = run_failures(run, [])
    assert failures[0]["idx"] is None
    assert failures[0]["signature"] == "run failed before any step"
