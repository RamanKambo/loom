// Loom 1.0.0 job: runs the shared job ledger (Tools/Context-Engineering, claude-doctrine scripts/orchestration)
// with this job's configuration, ledger.config.json beside this file, unless --config or LEDGER_CONFIG names another.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LEDGER_CONFIG ??= join(dirname(fileURLToPath(import.meta.url)), 'ledger.config.json');
const { main } = await import('file:///C:/Users/nnbfdh8/.claude/skills/claude-doctrine/scripts/orchestration/ledger.mjs');
main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
  console.error(e.stack ?? String(e));
  process.exit(2);
});
