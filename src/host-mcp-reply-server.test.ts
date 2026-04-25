import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DATA_DIR } from './config.js';
import { resolveGroupIpcPath } from './group-folder.js';
import {
  assertValidContext,
  buildHostMcpReplyHandler,
  hostMcpReplySchema,
  MAX_REPLY_TEXT_LEN,
} from './host-mcp-reply-server.js';

// Unique group folder per test run so parallel test workers don't collide
// and any leaked files are trivially identifiable.
let testGroup: string;
const validRequestId = '12345678-1234-1234-1234-123456789012';
const validChatJid = 'chat@g.us';

beforeEach(() => {
  testGroup = `hostmcptest-${Math.random().toString(36).slice(2, 10)}`;
});

afterEach(() => {
  try {
    const ipcDir = path.join(DATA_DIR, 'ipc', testGroup);
    fs.rmSync(ipcDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// -------- T13: happy path --------

describe('host_mcp_reply (T13 — happy path)', () => {
  it('writes an IPC message file with hardcoded chatJid/sourceGroup', async () => {
    const handler = buildHostMcpReplyHandler({
      sourceGroup: testGroup,
      chatJid: validChatJid,
      requestId: validRequestId,
    });

    const result = await handler({ text: 'hi' });

    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Reply delivered.',
    });

    const messagesDir = path.join(resolveGroupIpcPath(testGroup), 'messages');
    const files = fs
      .readdirSync(messagesDir)
      .filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);

    const payload = JSON.parse(
      fs.readFileSync(path.join(messagesDir, files[0]), 'utf-8'),
    );
    expect(payload).toMatchObject({
      type: 'message',
      chatJid: validChatJid,
      text: 'hi',
      groupFolder: testGroup,
    });
    expect(typeof payload.timestamp).toBe('string');
  });

  it('FIX 4: rejects second+ calls — exactly one message file, second call returns isError', async () => {
    const handler = buildHostMcpReplyHandler({
      sourceGroup: testGroup,
      chatJid: validChatJid,
      requestId: validRequestId,
    });

    const first = await handler({ text: 'first' });
    expect(first.isError).toBeFalsy();
    expect(first.content[0]).toEqual({ type: 'text', text: 'Reply delivered.' });

    const second = await handler({ text: 'second-attempt-spam' });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toMatch(/already called/i);

    const third = await handler({ text: 'third-attempt-spam' });
    expect(third.isError).toBe(true);

    // Only the first call wrote a file.
    const messagesDir = path.join(resolveGroupIpcPath(testGroup), 'messages');
    const files = fs
      .readdirSync(messagesDir)
      .filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);

    const payload = JSON.parse(
      fs.readFileSync(path.join(messagesDir, files[0]), 'utf-8'),
    );
    expect(payload.text).toBe('first');
  });

  it('rejects invalid argv shapes at context construction', () => {
    expect(() =>
      assertValidContext({
        sourceGroup: '../evil',
        chatJid: validChatJid,
        requestId: validRequestId,
      }),
    ).toThrow(/invalid sourceGroup/);

    expect(() =>
      assertValidContext({
        sourceGroup: testGroup,
        chatJid: validChatJid,
        requestId: 'not-a-uuid',
      }),
    ).toThrow(/invalid requestId/);

    expect(() =>
      assertValidContext({
        sourceGroup: testGroup,
        chatJid: '',
        requestId: validRequestId,
      }),
    ).toThrow(/invalid chatJid/);
  });
});

// -------- T14: strict schema rejects extras (agent cannot override routing) --

describe('host_mcp_reply (T14 — strict schema rejects extras)', () => {
  it('rejects an attempt to pass chatJid as a tool arg', () => {
    const result = hostMcpReplySchema.safeParse({
      text: 'hi',
      chatJid: 'attacker@g.us',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].code).toBe('unrecognized_keys');
    }
  });

  it('rejects an attempt to pass sourceGroup as a tool arg', () => {
    const result = hostMcpReplySchema.safeParse({
      text: 'hi',
      sourceGroup: 'main',
    });
    expect(result.success).toBe(false);
  });

  it('rejects prototype-pollution-style keys', () => {
    const result = hostMcpReplySchema.safeParse({
      text: 'hi',
      __proto__: { polluted: true },
    });
    // Zod strictObject rejects; __proto__ never reaches a hot path anyway
    // because the schema extracts only `text`.
    expect(result.success).toBe(false);
  });

  it('accepts the canonical { text } shape', () => {
    const result = hostMcpReplySchema.safeParse({ text: 'ok' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ text: 'ok' });
  });
});

// -------- T15: size cap --------

describe('host_mcp_reply (T15 — size cap)', () => {
  it('rejects text exceeding the 40K limit', () => {
    const oversized = 'x'.repeat(MAX_REPLY_TEXT_LEN + 1);
    const result = hostMcpReplySchema.safeParse({ text: oversized });
    expect(result.success).toBe(false);
  });

  it('accepts text at exactly the 40K boundary', () => {
    const atLimit = 'x'.repeat(MAX_REPLY_TEXT_LEN);
    const result = hostMcpReplySchema.safeParse({ text: atLimit });
    expect(result.success).toBe(true);
  });

  it('rejects an empty string', () => {
    const result = hostMcpReplySchema.safeParse({ text: '' });
    expect(result.success).toBe(false);
  });
});
