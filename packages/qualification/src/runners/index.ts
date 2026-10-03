import type { Runner } from '../types.js';
import { CSHARP_RUNNERS } from './csharp.js';
import { DOCUMENT_RUNNERS } from './documents.js';
import { OPENAPI_RUNNERS } from './openapi.js';
import { POWERSHELL_RUNNERS } from './powershell.js';
import { SQL_RUNNERS } from './sql.js';
import { TYPESCRIPT_RUNNERS } from './typescript.js';

/** Built-in runner per check-definition runner id; a check names a runner, never command text. */
export const RUNNERS: Readonly<Record<string, Runner>> = {
  ...SQL_RUNNERS,
  ...POWERSHELL_RUNNERS,
  ...CSHARP_RUNNERS,
  ...TYPESCRIPT_RUNNERS,
  ...OPENAPI_RUNNERS,
  ...DOCUMENT_RUNNERS,
};
