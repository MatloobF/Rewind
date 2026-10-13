// Entry point: `npm run dev` (restarts on file changes) or `npm start`.
import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || 4000;

createApp().listen(PORT, () => {
  console.log(`Rewind server listening on http://localhost:${PORT}`);
});
