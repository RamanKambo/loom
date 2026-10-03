import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Version of the @loom/core engine that renders and evaluates, recorded in manifests and baselines. */
export const ENGINE_VERSION: string = (() => {
  const entry = import.meta.resolve('@loom/core');
  const pkg = new URL('../package.json', entry);
  return (JSON.parse(readFileSync(fileURLToPath(pkg), 'utf8')) as { version: string }).version;
})();
