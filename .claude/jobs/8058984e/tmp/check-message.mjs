// Holds a commit message to Loom's release wording: every prohibited marker it contains is printed.
import { readFileSync } from 'node:fs';
import { prohibitedMarkers } from 'file:///C:/Users/nnbfdh8/Codebase/Tools/loom/packages/core/dist/index.js';

const text = readFileSync(process.argv[2], 'utf8');
const found = text.split('\n').flatMap((line, i) => prohibitedMarkers(line).map((m) => `line ${i + 1}: ${m.kind} '${m.match}'`));
console.log(`prohibited markers: ${found.length}`);
for (const f of found) console.log(f);
process.exit(found.length ? 1 : 0);
