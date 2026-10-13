import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SANDBOX_DIR } from './safePath.js';

// The messy starting state for the file-organizer agent. Always the same, so
// every run (and every replay of a run) starts from identical files.
// Contents are short text placeholders, even for .jpg/.pdf, so read_file works.
export const SEED_FILES = {
  'IMG_2041.png': 'placeholder image: screenshot of a chat',
  'vacation-photo.jpg': 'placeholder image: beach at sunset',
  'invoice-march.pdf': 'placeholder pdf: invoice #1042, March, $120',
  'tax-return-2025.pdf': 'placeholder pdf: 2025 tax return',
  'resume_final_v2.docx': 'placeholder document: resume',
  'meeting-notes.txt': 'Meeting notes\n- ship phase 1\n- review the sandbox rules\n',
  'todo.md': '# TODO\n- [ ] sort these files\n- [ ] pay invoice\n',
  'budget.csv': 'month,amount\nJan,1200\nFeb,1150\nMar,1300\n',
  'song.mp3': 'placeholder audio: demo track',
  // No extension: the agent has to read it to know what it is.
  'untitled': 'Pancakes\n2 eggs, 1 cup flour, 1 cup milk. Whisk and fry.\n',
  'misc/draft.txt': 'Draft blog post about time-travel debugging.\n',
};

// Kept so the empty sandbox folder stays in git.
const KEEP = '.gitkeep';

// Empties `root` (except .gitkeep) and writes SEED_FILES into it.
// `root` is a parameter only so tests can use a temporary folder.
export async function seed(root = SANDBOX_DIR) {
  await fs.mkdir(root, { recursive: true });

  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.name === KEEP) continue;
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      // Remove only the link itself, never what it points to.
      await fs.unlink(full);
    } else {
      await fs.rm(full, { recursive: true, force: true });
    }
  }

  for (const [rel, content] of Object.entries(SEED_FILES)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

// Run as a script: `npm run seed` or `node seed.js`.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await seed();
  console.log(`Seeded ${Object.keys(SEED_FILES).length} files into ${SANDBOX_DIR}`);
}
