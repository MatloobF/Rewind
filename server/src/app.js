import express from 'express';
import { api } from './api.js';
import { HttpError } from './errors.js';

// Builds the Express app without listening, so tests can start it on any port.
export function createApp() {
  const app = express();
  // LLM requests carry the whole conversation plus tool definitions, which
  // easily passes Express's 100kb default on a long run.
  app.use(express.json({ limit: '10mb' }));

  app.use('/api', api);

  app.use((req, res) => res.status(404).json({ error: `no route for ${req.method} ${req.path}` }));

  // Express 5 sends errors thrown in async handlers here.
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    // Bad JSON or a body over the limit, from express.json().
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'body too large' });
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
