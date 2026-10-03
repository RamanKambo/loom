import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excludedDirectories = new Set(['.git', 'node_modules', 'dist']);
const within = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

function markdownFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) files.push(...markdownFiles(full));
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files.sort();
}

function outsideFences(source, findings, file) {
  const lines = source.split(/\r?\n/);
  const prose = [];
  let block;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence && !block) {
      block = { delimiter: fence[1][0], size: fence[1].length, language: fence[2].trim(), lines: [], line: index + 1 };
    } else if (fence && block && fence[1][0] === block.delimiter && fence[1].length >= block.size && !fence[2].trim()) {
      if (block.language === 'json') {
        try { JSON.parse(block.lines.join('\n')); }
        catch (error) { findings.push({ file, line: block.line, problem: `Invalid fenced JSON: ${error.message}` }); }
      }
      block = undefined;
    } else if (block) {
      block.lines.push(line);
    } else {
      prose.push({ line: index + 1, text: line });
    }
  }
  if (block) findings.push({ file, line: block.line, problem: 'Unclosed code fence' });
  return prose;
}

function anchors(source) {
  const found = new Set();
  const repetitions = new Map();
  for (const { text } of outsideFences(source, [], '')) {
    const heading = text.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*$/);
    if (!heading) continue;
    const base = heading[1].toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = repetitions.get(base) ?? 0;
    repetitions.set(base, count + 1);
    found.add(count ? `${base}-${count}` : base);
  }
  for (const match of source.matchAll(/<(?:a|span)\b[^>]*(?:id|name)=["']([^"']+)["']/gi)) found.add(match[1]);
  return found;
}

function check(root, files, forbiddenTerms = []) {
  root = fs.realpathSync(root);
  const findings = [];
  let links = 0;
  for (const input of files) {
    const file = path.resolve(root, input);
    if (!fs.existsSync(file) || !within(root, fs.realpathSync(file))) {
      findings.push({ file: input, problem: 'Input is missing or outside the selected root' });
      continue;
    }
    const source = fs.readFileSync(file, 'utf8');
    const display = path.relative(root, file).replaceAll(path.sep, '/');
    const prose = outsideFences(source, findings, display);
    for (const term of forbiddenTerms) {
      if (source.toLowerCase().includes(term.toLowerCase())) findings.push({ file: display, problem: `Forbidden term: ${term}` });
    }
    for (const { text, line } of prose) {
      if (/\b(?:legacy|v2|backward[ -]+compatibility)\b/i.test(text)) findings.push({ file: display, line, problem: 'Historical product terminology in explanatory text' });
      if (/\b(?:D|T)\d+\b|\b(?:INIT|CFG|LOAD|NEST|EXISTS|REQUIRED|COR|KNOW|RDY|REP|BEH|HOST|BASE|EVI|MCP|DOC|DES|QUAL|WP|DEL)[-_ ]\d+\b/.test(text)) {
        findings.push({ file: display, line, problem: 'Internal specification marker in explanatory text' });
      }
      for (const match of text.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^)]+)\)/g)) {
        let target = match[1];
        if (target.startsWith('<')) target = target.slice(1, -1);
        else target = target.replace(/\s+["'][^"']*["']$/, '');
        if (/^(?:https?:|mailto:|loom:)/i.test(target)) continue;
        links++;
        let decoded;
        try { decoded = decodeURIComponent(target); }
        catch { findings.push({ file: display, line, problem: `Invalid link encoding: ${target}` }); continue; }
        const hash = decoded.indexOf('#');
        const pathname = hash < 0 ? decoded : decoded.slice(0, hash);
        const anchor = hash < 0 ? '' : decoded.slice(hash + 1);
        const resolved = pathname ? path.resolve(path.dirname(file), pathname) : file;
        if (!within(root, resolved) || !fs.existsSync(resolved) || !within(root, fs.realpathSync(resolved))) {
          findings.push({ file: display, line, problem: `Missing or out-of-root link: ${target}` });
        } else if (anchor && path.extname(resolved).toLowerCase() === '.md' && !anchors(fs.readFileSync(resolved, 'utf8')).has(anchor)) {
          findings.push({ file: display, line, problem: `Missing heading: ${target}` });
        }
      }
    }
  }
  return { files: files.length, localLinks: links, findings, limits: 'Checks inline local links, Markdown heading anchors, fences, fenced JSON and selected wording. Does not validate remote links, reference-style links, Loom records or engineering correctness.' };
}

function selfTest() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-doc-check-'));
  const resolvedTemp = fs.realpathSync(temp);
  try {
    fs.writeFileSync(path.join(temp, 'target.md'), '# Valid target\n');
    fs.writeFileSync(path.join(temp, 'good.md'), '# Good\n\n[Target](target.md#valid-target)\n\n```json\n{"ok":true}\n```\n');
    assert.equal(check(temp, ['good.md']).findings.length, 0);
    fs.writeFileSync(path.join(temp, 'bad.md'), '# Bad\n[Missing](absent.md)\n[Heading](target.md#absent)\n[Escape](../outside.md)\n```json\n{bad}\n```\n```text\nunfinished\n');
    const bad = check(temp, ['bad.md']);
    assert.equal(bad.findings.length, 5);
    assert.equal(check(temp, ['good.md'], ['valid']).findings.length, 1);
    assert(anchors('# Name\n# Name\n').has('name-1'));
    process.stdout.write('Self-test passed: valid links, missing targets/anchors, root containment, JSON, fences, forbidden terms and repeated headings.\n');
  } finally {
    if (fs.realpathSync(temp) !== resolvedTemp || !within(fs.realpathSync(os.tmpdir()), resolvedTemp)) throw new Error('Temporary cleanup root changed');
    fs.rmSync(resolvedTemp, { recursive: true });
  }
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  selfTest();
} else {
  let root = packageRoot;
  const files = [];
  const forbiddenTerms = [];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--root') root = path.resolve(value);
    else if (flag === '--file') files.push(value);
    else if (flag === '--forbid-term') forbiddenTerms.push(value);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  const result = check(root, files.length ? files : markdownFiles(root));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.findings.length ? 1 : 0;
}
