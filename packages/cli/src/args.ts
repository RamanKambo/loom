/** A command line split into its command, positional arguments and flags. */
export interface Args {
  command: string | null;
  positionals: string[];
  flags: Map<string, string | true>;
}

/** A command line the CLI cannot interpret; it exits with status 2. */
export class UsageError extends Error {}

/** Flags that never take a value; every other flag takes the next argument or its `=value`. */
const SWITCHES = new Set(['json', 'all', 'force', 'apply', 'draft', 'check', 'dry-run', 'self', 'metrics', 'store', 'list-cases', 'frozen', 'self-test', 'help']);

export function parseArgs(argv: readonly string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      if (!name) throw new UsageError(`unrecognized argument '${arg}'`);
      if (eq > 0) flags.set(name, arg.slice(eq + 1));
      else if (SWITCHES.has(name)) flags.set(name, true);
      else {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
        flags.set(name, value);
        i++;
      }
      continue;
    }
    if (command === null && !flags.has('self-test')) command = arg;
    else positionals.push(arg);
  }
  if (flags.has('self-test')) command = command ?? 'self-test';
  return { command, positionals, flags };
}

export const flag = (a: Args, name: string): string | undefined => {
  const v = a.flags.get(name);
  if (v === true) throw new UsageError(`--${name} needs a value`);
  return v;
};

export const has = (a: Args, name: string): boolean => a.flags.has(name);

export function required(a: Args, name: string): string {
  const v = flag(a, name);
  if (v === undefined) throw new UsageError(`--${name} is required`);
  return v;
}

/** A comma-separated list flag; absent means undefined, not empty. */
export function list(a: Args, name: string): string[] | undefined {
  const v = flag(a, name);
  return v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean);
}

export function integer(a: Args, name: string): number | undefined {
  const v = flag(a, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new UsageError(`--${name} must be a non-negative integer`);
  return Number(v);
}
