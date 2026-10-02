/**
 * The source notice every projection carries, each in its own syntax. It names
 * no time, machine or path, so a regenerated artifact is byte-identical.
 */
export const SOURCE_NOTICE =
  'Generated from the Loom model. Do not edit; edit the model and regenerate.';

export const SQL_NOTICE = `-- ${SOURCE_NOTICE}`;
/** PowerShell and YAML comment form. */
export const HASH_NOTICE = `# ${SOURCE_NOTICE}`;
export const MARKDOWN_NOTICE = `<!-- ${SOURCE_NOTICE} -->`;

/** Join lines into text that ends in exactly one newline. */
export function toText(lines: string[]): string {
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
