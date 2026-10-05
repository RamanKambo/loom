import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const norm = (s) => s.replace(/\s+/g, ' ').trim();

export function loadTasks(dir) {
  const tasks = new Map();
  for (const f of readdirSync(dir)) {
    if (!/^\d+\.json$/.test(f)) continue;
    const t = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    tasks.set(String(t.id), t);
  }
  return tasks;
}

function decisionsDefined(decisionTask) {
  const defined = new Set();
  for (const m of (decisionTask?.description ?? '').matchAll(/^\s*(\d+)([a-z])?[.)]/gm)) defined.add(m[1] + (m[2] ?? ''));
  return defined;
}

export function gate({ tasks, crosswalk, spec, decisionTaskId = '2' }) {
  const findings = [];
  const add = (code, detail) => findings.push({ code, detail });

  const statements = Array.isArray(crosswalk?.statements) ? crosswalk.statements : null;
  if (!statements) add('CROSSWALK_SHAPE', 'crosswalk.statements is not an array');
  else {
    statements.forEach((s, i) => {
      if (s.id !== i + 1) add('CROSSWALK_SHAPE', `statement at index ${i} has id ${s.id}, expected ${i + 1}`);
      if (!Array.isArray(s.tasks) || s.tasks.length === 0) add('STATEMENT_UNMAPPED', `#${s.id} ${s.section}`);
      else for (const t of s.tasks) {
        const task = tasks.get(String(t));
        if (!task || task.status === 'deleted') add('TASK_UNKNOWN', `#${s.id} maps to task ${t}, which does not exist`);
      }
      if (s.status === 'environment-limited') {
        const defined = decisionsDefined(tasks.get(decisionTaskId));
        if (!s.decision || !defined.has(String(s.decision))) add('ENVIRONMENT_LIMIT_UNDECIDED', `#${s.id} is environment-limited without a decision task ${decisionTaskId} defines`);
      } else if (s.status !== 'covered') add('STATEMENT_NOT_COVERED', `#${s.id} ${s.status}: ${s.gap ?? ''}`);
      if (spec !== undefined && !norm(spec).includes(norm(String(s.quote ?? '')))) add('QUOTE_NOT_IN_SPEC', `#${s.id} "${String(s.quote).slice(0, 60)}"`);
      const delivered = Array.isArray(s.tasks) && s.tasks.length > 0 && s.tasks.every((t) => tasks.get(String(t))?.status === 'completed');
      if (delivered && !(typeof s.evidence === 'string' && s.evidence.trim())) add('EVIDENCE_MISSING', `#${s.id} every owning task (${s.tasks.join(', ')}) is completed, but the statement names no evidence`);
    });
  }

  for (const [id, t] of tasks) {
    for (const b of t.blockedBy ?? []) {
      const other = tasks.get(String(b));
      if (!other) add('DEPENDENCY_UNKNOWN', `task ${id} is blocked by missing task ${b}`);
      else if (!(other.blocks ?? []).map(String).includes(id)) add('DEPENDENCY_ASYMMETRIC', `task ${id} blockedBy ${b}, but ${b}.blocks omits ${id}`);
    }
    for (const b of t.blocks ?? []) {
      const other = tasks.get(String(b));
      if (!other) add('DEPENDENCY_UNKNOWN', `task ${id} blocks missing task ${b}`);
      else if (!(other.blockedBy ?? []).map(String).includes(id)) add('DEPENDENCY_ASYMMETRIC', `task ${id} blocks ${b}, but ${b}.blockedBy omits ${id}`);
    }
  }

  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') { add('DEPENDENCY_CYCLE', [...path, id].join(' -> ')); return; }
    state.set(id, 'open');
    for (const b of tasks.get(id)?.blockedBy ?? []) if (tasks.has(String(b))) visit(String(b), [...path, id]);
    state.set(id, 'done');
  };
  for (const id of tasks.keys()) visit(id, []);

  const defined = decisionsDefined(tasks.get(decisionTaskId));
  for (const [id, t] of tasks) {
    if (id === decisionTaskId) continue;
    for (const m of (t.description ?? '').matchAll(/\bdecisions? (\d+)([a-z])?\b/gi)) {
      const ref = m[1] + (m[2] ?? '');
      if (!defined.has(ref)) add('DECISION_UNDEFINED', `task ${id} cites decision ${ref}, which task ${decisionTaskId} does not define`);
    }
  }
  return findings;
}

export function executionOrder(tasks) {
  const open = [...tasks.values()].filter((t) => t.status !== 'completed' && t.status !== 'deleted').map((t) => String(t.id));
  const pending = new Set(open);
  const order = [];
  while (pending.size) {
    const ready = [...pending].filter((id) => (tasks.get(id).blockedBy ?? []).every((b) => !pending.has(String(b)))).sort((a, b) => Number(a) - Number(b));
    if (!ready.length) return null;
    order.push(ready[0]);
    pending.delete(ready[0]);
  }
  return order;
}

function selfTest() {
  const task = (id, extra = {}) => ({ id, subject: `t${id}`, description: '', status: 'pending', blocks: [], blockedBy: [], ...extra });
  const clean = () => new Map([
    ['1', task('1', { blocks: ['2'] })],
    ['2', task('2', { blockedBy: ['1'], description: '1. first\n2. second\n6a. sub' })],
    ['3', task('3', { description: 'apply decision 1 and decision 6a' })],
  ]);
  const spec = 'Alpha must hold.\n| Row | value must be checked |';
  const cw = () => ({ statements: [
    { id: 1, section: 'S', quote: 'Alpha must hold.', tasks: [3], status: 'covered' },
    { id: 2, section: 'S', quote: 'value must be checked', tasks: [2], status: 'covered' },
  ] });
  const expect = (name, findings, code) => {
    const hit = findings.some((f) => f.code === code);
    if (!hit) throw new Error(`self-test "${name}" did not raise ${code}: ${JSON.stringify(findings)}`);
  };
  const base = gate({ tasks: clean(), crosswalk: cw(), spec });
  if (base.length) throw new Error(`self-test clean fixture raised ${JSON.stringify(base)}`);

  let c = cw(); c.statements[0].tasks = []; expect('unmapped', gate({ tasks: clean(), crosswalk: c, spec }), 'STATEMENT_UNMAPPED');
  c = cw(); c.statements[0].tasks = [99]; expect('unknown task', gate({ tasks: clean(), crosswalk: c, spec }), 'TASK_UNKNOWN');
  c = cw(); c.statements[1].status = 'partial'; expect('not covered', gate({ tasks: clean(), crosswalk: c, spec }), 'STATEMENT_NOT_COVERED');
  c = cw(); c.statements[1].quote = 'invented text'; expect('quote', gate({ tasks: clean(), crosswalk: c, spec }), 'QUOTE_NOT_IN_SPEC');
  c = cw(); c.statements[1].id = 5; expect('ids', gate({ tasks: clean(), crosswalk: c, spec }), 'CROSSWALK_SHAPE');
  let t = clean(); t.get('1').blocks = []; expect('asymmetric', gate({ tasks: t, crosswalk: cw(), spec }), 'DEPENDENCY_ASYMMETRIC');
  t = clean(); t.get('3').blockedBy = ['42']; expect('missing dep', gate({ tasks: t, crosswalk: cw(), spec }), 'DEPENDENCY_UNKNOWN');
  t = clean(); t.get('1').blockedBy = ['2']; t.get('2').blocks = ['1']; expect('cycle', gate({ tasks: t, crosswalk: cw(), spec }), 'DEPENDENCY_CYCLE');
  t = clean(); t.get('3').description = 'per decision 6c'; expect('decision', gate({ tasks: t, crosswalk: cw(), spec }), 'DECISION_UNDEFINED');
  c = cw(); c.statements[1].status = 'environment-limited'; c.statements[1].decision = '9'; expect('env limit', gate({ tasks: clean(), crosswalk: c, spec }), 'ENVIRONMENT_LIMIT_UNDECIDED');
  c = cw(); c.statements[1].status = 'environment-limited'; c.statements[1].decision = '6a';
  if (gate({ tasks: clean(), crosswalk: c, spec }).length) throw new Error('self-test: a decided environment limit must be silent');
  t = clean(); t.get('3').status = 'completed'; expect('evidence', gate({ tasks: t, crosswalk: cw(), spec }), 'EVIDENCE_MISSING');
  c = cw(); c.statements[0].evidence = 'node --test x.test.js: 3 pass';
  if (gate({ tasks: t, crosswalk: c, spec }).length) throw new Error('self-test: a delivered statement with evidence must be silent');
  t = clean(); t.get('1').blockedBy = ['3']; t.get('3').blocks = ['1'];
  const order = executionOrder(t);
  if (JSON.stringify(order) !== JSON.stringify(['3', '1', '2'])) throw new Error(`self-test order: expected 3,1,2 got ${order}`);
  t.get('1').status = 'completed';
  if (JSON.stringify(executionOrder(t)) !== JSON.stringify(['2', '3'])) throw new Error('self-test order: completed task not excluded');
  console.log('self-test PASS: 11 checks fired on planted defects, clean fixtures silent, execution order respects dependencies');
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) selfTest();
else {
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const tasks = loadTasks(get('--tasks'));
  const crosswalk = JSON.parse(readFileSync(get('--crosswalk'), 'utf8'));
  const spec = get('--spec') ? readFileSync(get('--spec'), 'utf8') : undefined;
  const findings = gate({ tasks, crosswalk, spec });
  const byCode = {};
  for (const f of findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
  for (const f of findings) console.log(`${f.code}\t${f.detail}`);
  const st = crosswalk.statements ?? [];
  const count = (s) => st.filter((x) => x.status === s).length;
  const evidenced = st.filter((x) => typeof x.evidence === 'string' && x.evidence.trim()).length;
  console.log(`statements ${st.length} · covered ${count('covered')} · partial ${count('partial')} · missing ${count('missing')} · evidenced ${evidenced} · tasks ${tasks.size}`);
  const order = executionOrder(tasks);
  console.log(`order ${order ? order.join(', ') : 'none (cycle)'}`);
  console.log(`findings ${findings.length} ${JSON.stringify(byCode)}`);
  process.exit(findings.length ? 1 : 0);
}
