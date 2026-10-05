// Companion to plan-gate.mjs; the crosswalk stays the only home of the statement-to-task mapping.
//   node crosswalk.mjs list <task>             prints that task's statements verbatim, for a worker brief
//   node crosswalk.mjs evidence <file.json>    appends {"<id>": "<evidence>"} to each statement's evidence, refusing unknown ids
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const path = join(dirname(fileURLToPath(import.meta.url)), 'loom-refinements-crosswalk.json');
const cw = JSON.parse(readFileSync(path, 'utf8'));
const [verb, arg] = process.argv.slice(2);

if (verb === 'list') {
  const mine = cw.statements.filter((s) => s.tasks.map(String).includes(String(arg)));
  for (const s of mine) console.log(`#${s.id} [${s.section}] ${s.quote}${s.resolution ? `\n    resolution: ${s.resolution}` : ''}${s.evidence ? `\n    evidence: ${s.evidence}` : ''}`);
  console.log(`task ${arg}: ${mine.length} statements, ${mine.filter((s) => s.evidence).length} with evidence`);
} else if (verb === 'evidence') {
  const updates = JSON.parse(readFileSync(arg, 'utf8'));
  for (const [id, evidence] of Object.entries(updates)) {
    const s = cw.statements[Number(id) - 1];
    if (!s || s.id !== Number(id)) throw new Error(`no statement ${id}`);
    if (typeof evidence !== 'string' || !evidence.trim()) throw new Error(`statement ${id}: evidence must be a non-empty string`);
    // A statement shared by several tasks accumulates each owner's evidence.
    s.evidence = s.evidence && !s.evidence.includes(evidence.trim()) ? `${s.evidence} · ${evidence.trim()}` : evidence.trim();
  }
  writeFileSync(path, JSON.stringify(cw, null, 2) + '\n');
  console.log(`recorded evidence on ${Object.keys(updates).length} statements`);
} else {
  console.error('usage: crosswalk.mjs list <task> | evidence <file.json>');
  process.exit(2);
}
