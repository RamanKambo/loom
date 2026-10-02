import { FINDING } from '../codes.js';
import { COLLECTIONS } from '../generated/registry.js';
import { KIND_OF_COLLECTION, recordKey, recordsOf, type CollectionName } from '../records.js';
import { ref, type Rule } from './context.js';

/** Machine paths and credential shapes; matched inside any string, case-insensitively. */
const MACHINE_PATH = /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._-]+\\|\/(?:home|Users|root|mnt|var|opt|etc|tmp)\/)/;
const CREDENTIAL = /(?:password|pwd|secret|accountkey|sharedaccesskey|sharedaccesssignature|client_secret|apikey)\s*=|:\/\/[^/\s:@]+:[^/\s@]+@/i;

/**
 * The portable model holds no workstation path, credential or live secret, so
 * the same model checks against any environment. An HTTP route is a path by
 * definition and is the only exempt field.
 */
export const portabilityRules: Rule = (ctx) => {
  for (const c of COLLECTIONS) {
    for (const record of recordsOf(ctx.model, c.collection as CollectionName)) {
      const id = recordKey(c.collection as CollectionName, record);
      const scan = (value: unknown, path: string, key: string): void => {
        if (typeof value === 'string') {
          if (key === 'path' && path.includes('/bindings/')) return;
          const problem = CREDENTIAL.test(value) ? 'a credential-shaped value' : MACHINE_PATH.test(value) ? 'a machine path' : null;
          if (problem) {
            ctx.report(FINDING.PORTABILITY_VIOLATION, path, `${path} holds ${problem}`, [ref(KIND_OF_COLLECTION[c.collection as CollectionName], id)], `replace the value at ${path} with a repository-relative path or a named configuration reference`);
          }
          return;
        }
        if (Array.isArray(value)) value.forEach((v, i) => scan(v, `${path}/${i}`, key));
        else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) scan(v, `${path}/${k}`, k);
      };
      scan(record, `${c.collection}/${id}`, '');
    }
  }
};
