import type { GuideResource } from './generated/types.js';
import { CONTRACT_DIGEST } from './generated/digest.js';
import { GUIDES, ORIENTATION } from './generated/guides.js';
import { canonicalHash } from './hash.js';

/**
 * The orientation the MCP server returns as its initialization instructions and the describe summary
 * opens with. Generation embeds it from Docs/guides/orientation.md and refuses one over the
 * instructions budget, so every adapter returns the same text.
 */
export const ORIENTATION_TEXT: string = ORIENTATION.text;

/** Every guide resource of this build, each with the digest of its exact text and the contract digest it describes. */
export function guides(): GuideResource[] {
  return GUIDES.map((g) => ({ uri: g.uri, title: g.title, text: g.text, contentDigest: g.contentDigest, contractDigest: CONTRACT_DIGEST }));
}

/** One guide resource by its URI, or null when the catalogue defines no guide there. */
export function guide(uri: string): GuideResource | null {
  return guides().find((g) => g.uri === uri) ?? null;
}

/**
 * The revision every description answers for: the contract digest and the digests of the embedded
 * guidance. The guidance is not part of the contract digest, so a cursor binds both.
 */
export const GUIDANCE_REVISION: string = canonicalHash({ contract: CONTRACT_DIGEST, orientation: ORIENTATION.contentDigest, guides: GUIDES.map((g) => g.contentDigest) });
