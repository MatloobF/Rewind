import express from 'express';
import { api } from './api.js';
import { createProxy } from './proxy.js';
import { HttpError } from './errors.js';

// Real LLM endpoint, without /v1 (the proxy adds it).
const DEFAULT_UPSTREAM = process.env.UPSTREAM_URL || 'http://localhost:11434';
// Where agents launched by the server (forks) reach it. Not taken from the
// request: through Vite's dev proxy that would be the :5173 address, which
// only forwards /api, not the /r LLM route.
const DEFAULT_SERVER_URL = process.env.REWIND_SERVER_URL || `http://localhost:${Number(process.env.PORT) || 4000}`;

// Builds the Express app without listening, so tests can start it on any
// port and point it at a fake upstream.
export function createApp({ upstreamUrl = DEFAULT_UPSTREAM, serverUrl = DEFAULT_SERVER_URL } = {}) {
  const app = express();
  app.locals.serverUrl = serverUrl.replace(/\/+$/, '');

  // LLM requests carry the whole conversation plus tool definitions, which
  // easily passes Express's 100kb default on a long run.
  app.use('/api', express.json({ limit: '10mb' }), api);
  // The proxy reads raw bytes itself, so it gets no JSON parser.
  app.use('/r', createProxy({ upstreamUrl }));

  app.use((req, res) => res.status(404).json({ error: `no route for ${req.method} ${req.path}` }));

  // Express 5 sends errors thrown in async handlers here.
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    // Bad JSON or a body over the limit, from the body parsers.
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'body too large' });
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
