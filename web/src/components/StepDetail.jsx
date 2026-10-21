import { useState } from 'react';
import ForkEditor from './ForkEditor.jsx';
import JsonView from './JsonView.jsx';
import Message from './Message.jsx';
import { formatMs, formatNumber } from '../format.js';
import { previousMessageCount, replyMessage, requestMessages, stepState } from '../steps.js';

function Section({ title, children }) {
  return (
    <section className="mt-6">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

export default function StepDetail({ step, steps, run }) {
  const reply = replyMessage(step);
  const [forking, setForking] = useState(false);
  // The server only forks finished runs: a running run's steps aren't final.
  const canFork = run.status !== 'running';

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-lg font-semibold">
          Step #{step.idx} <span className="text-zinc-400">{step.type}</span>
        </h2>
        <span className="text-sm text-zinc-400">
          {formatMs(step.latency_ms)} · {formatNumber(step.tokens_in)} in / {formatNumber(step.tokens_out)} out
        </span>
        {step.replayed && <span className="text-sm text-violet-300">replayed from parent run</span>}
        {!forking && (
          <button
            type="button"
            onClick={() => setForking(true)}
            disabled={!canFork}
            title={canFork ? 'Replay up to here, change this step, and run the rest live' : 'Wait until the run has finished'}
            className="ml-auto rounded border border-violet-500/50 px-3 py-1 text-sm text-violet-200 hover:bg-violet-500/10 disabled:opacity-40"
          >
            Fork from here
          </button>
        )}
      </div>
      <div className="mt-1 font-mono text-xs text-zinc-600" title="request_hash">
        {step.request_hash}
      </div>

      {forking && <ForkEditor run={run} step={step} onCancel={() => setForking(false)} />}

      {step.error && (
        <div className="mt-4 rounded border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
          {step.error}
        </div>
      )}
      {stepState(step) === 'pending' && (
        <div className="mt-4 rounded border border-zinc-700 p-3 text-sm text-zinc-400">
          {run.status === 'running'
            ? 'Call in progress...'
            : 'No response was recorded: the agent stopped during this call.'}
        </div>
      )}

      {step.type === 'llm' ? (
        <>
          {reply && (
            <Section title="Response">
              <Message message={reply} />
            </Section>
          )}
          <Conversation step={step} steps={steps} />
        </>
      ) : (
        step.response != null && (
          <Section title="Result">
            <JsonView value={step.response} />
          </Section>
        )
      )}

      <Section title="Raw request">
        <JsonView value={step.request} />
      </Section>
      {step.response != null && (
        <Section title="Raw response">
          <JsonView value={step.response} />
        </Section>
      )}
    </div>
  );
}

// The request's messages. By default only those that are new at this step
// (e.g. tool results), since every LLM request repeats the whole history.
function Conversation({ step, steps }) {
  const [showAll, setShowAll] = useState(false);
  const messages = requestMessages(step);
  const firstNew = previousMessageCount(steps, step);
  const shown = showAll ? messages : messages.slice(firstNew);
  const title = showAll
    ? `All ${messages.length} messages sent`
    : `New messages sent (${shown.length} of ${messages.length})`;

  return (
    <Section title={title}>
      {firstNew > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="mb-2 text-xs text-sky-300 hover:underline"
        >
          {showAll ? 'Show only new messages' : `Show ${firstNew} earlier messages`}
        </button>
      )}
      <div className="space-y-2">
        {shown.map((message, i) => (
          <Message key={i} message={message} />
        ))}
      </div>
    </Section>
  );
}
