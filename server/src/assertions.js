// Eval assertions: structured JSON checked by plain code, never by an LLM.
// Pure functions over a finished run and its steps (as getRun returns them),
// so they are easy to test and give the same answer every time.
//
// Each type has validate(a), returning an error message or null, and
// check(run, steps, a), returning a failure message or null. A new type is
// one more entry in CHECKS.
import { isPlainObject } from './validate.js';

const RUN_STATUSES = ['success', 'failed'];

const isNonEmptyString = (v) => typeof v === 'string' && v !== '';
const isCount = (v) => Number.isInteger(v) && v >= 0;

const toolSteps = (steps) => steps.filter((s) => s.type === 'tool');
const toolName = (step) => step.request?.name;
const stepList = (steps) => steps.map((s) => s.idx).join(', ');

// The agent's last answer: the message of the last LLM step that finished.
// Empty if the run ended on a tool call (e.g. it hit its step limit).
export function finalOutput(steps) {
  const last = steps.findLast((s) => s.type === 'llm' && s.response != null);
  return last?.response?.choices?.[0]?.message?.content ?? '';
}

// Each type's fields besides `type`, with a check for each.
const CHECKS = {
  run_status: {
    fields: { status: (v) => RUN_STATUSES.includes(v) || `must be one of ${RUN_STATUSES.join(', ')}` },
    check: (run, steps, a) =>
      run.status === a.status ? null : `run status was ${run.status}, expected ${a.status}`,
  },

  // Counts Rewind steps (LLM and tool), not the agent's loop turns.
  max_steps: {
    fields: { max: (v) => (Number.isInteger(v) && v >= 1) || 'must be a positive integer' },
    check: (run, steps, a) => (steps.length <= a.max ? null : `took ${steps.length} steps, max ${a.max}`),
  },

  must_call_tool: {
    fields: { tool: (v) => isNonEmptyString(v) || 'must be a non-empty string' },
    check: (run, steps, a) =>
      toolSteps(steps).some((s) => toolName(s) === a.tool) ? null : `never called ${a.tool}`,
  },

  must_not_call_tool: {
    fields: { tool: (v) => isNonEmptyString(v) || 'must be a non-empty string' },
    check: (run, steps, a) => {
      const calls = toolSteps(steps).filter((s) => toolName(s) === a.tool);
      return calls.length === 0 ? null : `called ${a.tool} at steps ${stepList(calls)}`;
    },
  },

  max_tool_errors: {
    fields: { max: (v) => isCount(v) || 'must be a non-negative integer' },
    check: (run, steps, a) => {
      const errors = toolSteps(steps).filter((s) => s.error != null);
      if (errors.length <= a.max) return null;
      return `${errors.length} tool errors (steps ${stepList(errors)}), max ${a.max}`;
    },
  },

  // Ignores case: LLM wording varies, and "Sorted" vs "sorted" shouldn't fail a test.
  final_output_contains: {
    fields: { text: (v) => isNonEmptyString(v) || 'must be a non-empty string' },
    check: (run, steps, a) =>
      finalOutput(steps).toLowerCase().includes(a.text.toLowerCase())
        ? null
        : `final output doesn't contain "${a.text}"`,
  },
};

export const ASSERTION_TYPES = Object.keys(CHECKS);

// Validates an eval's assertions: a non-empty array of known types, each with
// exactly its own fields. Extra keys are rejected so a typo or an unsupported
// option fails loudly instead of being ignored.
// Returns an error message, or null if all are valid.
export function assertionsError(assertions) {
  if (!Array.isArray(assertions) || assertions.length === 0) {
    return 'assertions must be a non-empty array';
  }
  for (const [i, a] of assertions.entries()) {
    const where = `assertions[${i}]`;
    if (!isPlainObject(a)) return `${where} must be an object`;
    const spec = Object.hasOwn(CHECKS, a.type) ? CHECKS[a.type] : null;
    if (!spec) return `${where}.type must be one of ${ASSERTION_TYPES.join(', ')}`;

    for (const [field, valid] of Object.entries(spec.fields)) {
      const result = valid(a[field]);
      if (result !== true) return `${where}.${field} ${result}`;
    }
    const extra = Object.keys(a).find((k) => k !== 'type' && !Object.hasOwn(spec.fields, k));
    if (extra) return `${where} has an unknown field "${extra}" for ${a.type}`;
  }
  return null;
}

// Checks valid assertions against a finished run and its steps.
// Returns { passed, failures: [{ index, assertion, message }] }.
export function checkAssertions(run, steps, assertions) {
  const failures = [];
  for (const [index, assertion] of assertions.entries()) {
    const message = CHECKS[assertion.type].check(run, steps, assertion);
    if (message) failures.push({ index, assertion, message });
  }
  return { passed: failures.length === 0, failures };
}
