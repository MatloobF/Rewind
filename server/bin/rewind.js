#!/usr/bin/env node
// Entry point for the `rewind` command (`npm link` in server/ installs it).
// The logic lives in src/cli.js so tests can import it.
import { main } from '../src/cli.js';

process.exitCode = await main(process.argv.slice(2));
