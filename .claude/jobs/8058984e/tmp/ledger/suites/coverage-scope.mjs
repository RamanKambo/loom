// Holds one task to the capability entries it owns, over Loom's own `coverage --check`.
// A task supplies only its area suites' TAP results, so verification cases of suites it did not run
// are reported unsupplied; every other finding still counts, and so does any finding on a named entry.
// Exit 0 only when every named entry exists, no other finding remains and the named entries have none.
// usage (cwd: the Loom root): node coverage-scope.mjs --results <tap,...> --capabilities <id,...>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const results = arg('--results');
const ids = (arg('--capabilities') ?? '').split(',').filter(Boolean);
if (!results || !ids.length) {
  console.log('usage: coverage-scope.mjs --results <tap,...> --capabilities <id,...>');
  process.exit(2);
}

const register = JSON.parse(readFileSync('qualification/capabilities.json', 'utf8'));
const known = new Set(register.capabilities.map((c) => c.id));
const missing = ids.filter((id) => !known.has(id));

let out;
try {
  out = execFileSync(process.execPath, ['packages/cli/dist/index.js', 'coverage', '--check', '--results', results, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  // coverage --check exits 1 whenever it reports a finding; its JSON envelope is still on stdout.
  if (!e.stdout) throw e;
  out = e.stdout;
}
const env = JSON.parse(out);
const named = (f) => ids.some((id) => f.path === `qualification/capabilities.json#${id}`);
const unsupplied = (f) => f.code === 'CAPABILITY_CASE_FAILED' && /^no supplied result shows/.test(f.message);
const other = env.findings.filter((f) => !named(f) && !unsupplied(f));
const scoped = env.findings.filter(named);

const d = env.data ?? {};
console.log(`coverage scope: capabilities ${d.capabilities} cases ${d.cases} verified ${d.verified}; missing entries: ${missing.length ? missing.join(', ') : 'none'}; other findings: ${other.length}; findings on ${ids.join(', ')}: ${scoped.length}`);
for (const f of [...other, ...scoped]) console.log(`${f.code} ${f.path}: ${f.message}`);
process.exit(missing.length === 0 && other.length === 0 && scoped.length === 0 ? 0 : 1);
