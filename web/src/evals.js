// Eval helpers for the editor and pages. The assertion types match
// server/src/assertions.js; the server is the only validator, so these only
// shape the form's rows into JSON and describe assertions in words.

// Every assertion type has exactly one field besides `type`.
//   kind 'status': run_status's select, 'int': a number input, 'text': a text input
export const FIELDS = {
  run_status: { name: 'status', kind: 'status' },
  max_steps: { name: 'max', kind: 'int' },
  must_call_tool: { name: 'tool', kind: 'text' },
  must_not_call_tool: { name: 'tool', kind: 'text' },
  max_tool_errors: { name: 'max', kind: 'int' },
  final_output_contains: { name: 'text', kind: 'text' },
};

export const ASSERTION_TYPES = Object.keys(FIELDS);
export const RUN_STATUSES = ['success', 'failed'];

let nextId = 1;

// A form row: the input value is kept as a string while editing.
function row(type, value, { include = true, reason = null, added = false } = {}) {
  return { id: nextId++, include, type, value: String(value ?? ''), reason, added };
}

// One row per draft suggestion, all ticked.
export function rowsFromDraft(draft) {
  return draft.suggestions.map(({ assertion, reason }) =>
    row(assertion.type, assertion[FIELDS[assertion.type].name], { reason }),
  );
}

// A row the user adds: run_status starts at 'success', the others empty.
export const newRow = (type) =>
  row(type, FIELDS[type].kind === 'status' ? 'success' : '', { added: true });

// The ticked rows as assertions for POST /api/evals. Whole numbers become
// integers; anything else is sent as typed, so the server's 400 message
// explains the problem (e.g. "assertions[1].max must be a positive integer").
export function assertionsFromRows(rows) {
  return rows
    .filter((r) => r.include)
    .map((r) => {
      const { name, kind } = FIELDS[r.type];
      const value = kind === 'int' && /^\d+$/.test(r.value.trim()) ? Number(r.value.trim()) : r.value;
      return { type: r.type, [name]: value };
    });
}

// An assertion in plain words, for the eval page.
export function describeAssertion(a) {
  switch (a.type) {
    case 'run_status':
      return `run status is ${a.status}`;
    case 'max_steps':
      return `at most ${a.max} steps`;
    case 'must_call_tool':
      return `calls ${a.tool}`;
    case 'must_not_call_tool':
      return `never calls ${a.tool}`;
    case 'max_tool_errors':
      return a.max === 0 ? 'no tool errors' : `at most ${a.max} tool errors`;
    case 'final_output_contains':
      return `final output contains "${a.text}"`;
    default:
      return JSON.stringify(a);
  }
}

// 'pass' | 'fail' | 'running' for a result row, or 'never' when there is none.
export function verdict(result) {
  if (result == null) return 'never';
  if (result.passed === null) return 'running';
  return result.passed ? 'pass' : 'fail';
}
