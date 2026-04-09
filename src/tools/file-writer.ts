/**
 * File writer tool — allows the agent to update its own soul/memory files.
 * Only files within the ATP instance directory can be written.
 * This is intentionally the ONLY write tool — the agent can only write to its own memory.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ALLOWED_FILES = ['SOUL.md', 'SOULPAIR.md', 'DEMEANOR.md'] as const;
export type PersonaFileName = (typeof ALLOWED_FILES)[number];

export interface FileWriteRequest {
  file: PersonaFileName;
  content: string;
}

/**
 * Write content to a persona file. Only SOUL.md, SOULPAIR.md, DEMEANOR.md are allowed.
 * Throws on unauthorized file names.
 */
export function writePersonaFile(atpPath: string, req: FileWriteRequest): void {
  if (!(ALLOWED_FILES as readonly string[]).includes(req.file)) {
    throw new Error(
      `Unauthorized file: ${req.file}. Only ${ALLOWED_FILES.join(', ')} are writable.`,
    );
  }
  const filePath = resolve(atpPath, req.file);
  writeFileSync(filePath, req.content, 'utf-8');
}

/**
 * Read a persona file. Returns empty string if the file doesn't exist.
 */
export function readPersonaFile(atpPath: string, file: string): string {
  const filePath = resolve(atpPath, file);
  if (!existsSync(filePath)) return '';
  return readFileSync(filePath, 'utf-8');
}

/** The write protocol tag regex — matches [VECTRA_WRITE:filename]...[/VECTRA_WRITE] blocks. */
const WRITE_BLOCK_RE =
  /\[VECTRA_WRITE:(SOUL\.md|USER\.md|AGENTS\.md)\]\n([\s\S]*?)\n\[\/VECTRA_WRITE\]/g;

/**
 * Parse VECTRA_WRITE blocks from a model response.
 * Returns the extracted write requests and the response with blocks stripped.
 */
export function parseWriteBlocks(response: string): {
  writes: FileWriteRequest[];
  cleaned: string;
} {
  const writes: FileWriteRequest[] = [];

  const cleaned = response.replace(WRITE_BLOCK_RE, (_match, file: string, content: string) => {
    writes.push({ file: file as PersonaFileName, content });
    return ''; // strip from visible response
  });

  return {
    writes,
    cleaned: cleaned.trim(),
  };
}

/**
 * Process write blocks: parse, write files, return cleaned response.
 * Fails silently on write errors — never crashes the message loop.
 */
export function processWriteBlocks(atpPath: string, response: string): string {
  try {
    const { writes, cleaned } = parseWriteBlocks(response);
    for (const req of writes) {
      try {
        writePersonaFile(atpPath, req);
        process.stderr.write(
          `[vectra-persona] Updated ${req.file} (${req.content.length} chars)\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[vectra-persona] Failed to write ${req.file}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    return cleaned;
  } catch {
    // If parsing itself fails, return original response untouched
    return response;
  }
}
