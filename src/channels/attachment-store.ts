import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB — Slack free-plan default is 1 GB; this is a safety cap

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
  return base.slice(0, 120) || 'file';
}

export interface SavedAttachment {
  relativePath: string; // e.g. "incoming/1776629xxx-report.pdf" — relative to /workspace/group
  absolutePath: string; // host path
  bytes: number;
}

/**
 * Persist an inbound attachment to `groups/{folder}/incoming/{epochMs}-{name}`.
 * Returns the relative path the container sees, suitable for embedding in the
 * message content so the agent can read the file with pdftotext / Read / etc.
 */
export async function saveAttachment(
  groupFolder: string,
  originalName: string,
  buffer: Buffer,
): Promise<SavedAttachment | undefined> {
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    logger.warn(
      { groupFolder, originalName, bytes: buffer.length },
      'Attachment exceeds size cap, skipping',
    );
    return undefined;
  }
  const safeName = sanitizeFilename(originalName);
  const prefixed = `${Date.now()}-${safeName}`;
  const incomingDir = path.join(GROUPS_DIR, groupFolder, 'incoming');
  await fs.promises.mkdir(incomingDir, { recursive: true });
  const absolutePath = path.join(incomingDir, prefixed);
  await fs.promises.writeFile(absolutePath, buffer);
  return {
    relativePath: `incoming/${prefixed}`,
    absolutePath,
    bytes: buffer.length,
  };
}
