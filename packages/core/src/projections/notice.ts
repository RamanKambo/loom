/**
 * The source notice every projection carries, each in its own syntax. It names
 * no time, machine or path, so a regenerated artifact is byte-identical.
 */
export const SOURCE_NOTICE =
  'Generated from the Loom model. Do not edit; edit the model and regenerate.';

export const SQL_NOTICE = `-- ${SOURCE_NOTICE}`;
/** PowerShell and YAML comment form. */
export const HASH_NOTICE = `# ${SOURCE_NOTICE}`;
/** C# and TypeScript comment form. */
export const SLASH_NOTICE = `// ${SOURCE_NOTICE}`;
/** Markdown and XML comment form. */
export const MARKDOWN_NOTICE = `<!-- ${SOURCE_NOTICE} -->`;

/**
 * The notice of a reference the build generates from Loom's own authored
 * contract, such as the operations reference, rather than from a model.
 */
export const CONTRACT_NOTICE =
  'Generated from the Loom contract. Do not edit; edit the authored contract and regenerate.';

/** Join lines into text that ends in exactly one newline. */
export function toText(lines: string[]): string {
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
