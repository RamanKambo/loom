#!/usr/bin/env node
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { run } from './cli.js';

// dist/index.js sits three levels below the Loom root, which holds Loom's own qualification policy and fixtures.
const LOOM_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

run(process.argv.slice(2), process.cwd(), LOOM_ROOT, (line) => console.log(line))
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  });
