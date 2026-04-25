/**
 * Host-side stdio MCP server (U8).
 *
 * Exposes exactly one tool — `host_mcp_reply(text)` — as the only write
 * primitive available to the spawned host-side `claude -p` session that
 * services a `host_mcp_query` request. The agent's allowed-tools argv
 * revokes Bash/Write/Edit, so this tool is the single path by which a
 * host-side answer reaches the user's chat.
 *
 * `sourceGroup`, `chatJid`, and `requestId` are baked into the server at
 * construction time (from `process.argv[2..4]`). They are NOT in the tool's
 * input schema — a prompt-injected agent cannot override where the reply
 * goes, since those values come from the trusted daemon, not the LLM.
 *
 * One server instance per spawned `claude -p` session. The daemon writes a
 * per-spawn `.mcp-config.json` that registers this server with the positional
 * argv, and cleans up both that config file and this process on exit.
 *
 * Mirrors the shape of `container/agent-runner/src/ipc-mcp-stdio.ts` — the
 * container-side IPC bridge — but runs on the host, serves a single write
 * tool, and takes its context from argv rather than env vars.
 */

import fs from 'fs';
import path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { isValidGroupFolder, resolveGroupIpcPath } from './group-folder.js';

// Defensive independence: even though the daemon already validates these
// shapes in `src/ipc.ts`, the MCP server is a separate process and re-validates
// so a mis-wired spawn can't silently write to the wrong group.
const REQUEST_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// Matches the daemon's `HOST_MCP_MAX_REPLY_LEN`-equivalent cap. Bumped to 40K
// to allow for longer PitchBook summaries while still bounding memory.
export const MAX_REPLY_TEXT_LEN = 40_000;

/**
 * Zod schema for `host_mcp_reply` input. `strictObject` rejects any extra
 * keys (e.g. `chatJid`, `sourceGroup`) the agent might try to pass — those
 * are hardcoded from argv and cannot be influenced by the LLM.
 *
 * Exported for unit tests (T13–T15).
 */
export const hostMcpReplySchema = z.strictObject({
  text: z.string().min(1).max(MAX_REPLY_TEXT_LEN),
});

export interface HostMcpReplyContext {
  sourceGroup: string;
  chatJid: string;
  requestId: string;
}

/**
 * Validate the trusted-but-re-checked positional argv. Throws on any shape
 * violation so the server fails loud at startup rather than writing a reply
 * into the wrong place.
 */
export function assertValidContext(ctx: HostMcpReplyContext): void {
  if (!isValidGroupFolder(ctx.sourceGroup)) {
    throw new Error(
      `host-mcp-reply-server: invalid sourceGroup "${ctx.sourceGroup}"`,
    );
  }
  if (!REQUEST_ID_PATTERN.test(ctx.requestId)) {
    throw new Error(
      `host-mcp-reply-server: invalid requestId "${ctx.requestId}"`,
    );
  }
  if (
    typeof ctx.chatJid !== 'string' ||
    ctx.chatJid.length === 0 ||
    ctx.chatJid.length > 512
  ) {
    throw new Error('host-mcp-reply-server: invalid chatJid');
  }
}

/**
 * Atomic IPC file write (tmp → rename). Mirrors the container-side pattern
 * at `container/agent-runner/src/ipc-mcp-stdio.ts:23-35` and the daemon-side
 * pattern in `src/ipc.ts`.
 */
export function writeIpcMessageFile(
  messagesDir: string,
  payload: Record<string, unknown>,
): string {
  fs.mkdirSync(messagesDir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filePath = path.join(messagesDir, filename);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, filePath);
  return filePath;
}

/**
 * Build the `host_mcp_reply` tool handler with the trusted context baked in.
 * Exported so unit tests can exercise the write path without the MCP wire
 * protocol.
 *
 * Enforces single-reply semantics: the first call writes a message file and
 * returns success; subsequent calls return `isError: true` and write nothing.
 * Without this guard a prompt-injected agent could call the tool repeatedly
 * to spam the user's chat with N copies of the same reply (each pinned to
 * the correct chatJid by argv, so not a security boundary, but a UX abuse).
 */
export function buildHostMcpReplyHandler(ctx: HostMcpReplyContext): (args: {
  text: string;
}) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  assertValidContext(ctx);
  let callCount = 0;

  return async ({ text }) => {
    callCount += 1;
    if (callCount > 1) {
      // eslint-disable-next-line no-console
      console.warn(
        `[host-mcp-reply-server] requestId=${ctx.requestId} attempted ${callCount} replies; rejecting subsequent call`,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: 'host_mcp_reply already called for this request. Reply was delivered. Exit.',
          },
        ],
        isError: true,
      };
    }

    const messagesDir = path.join(
      resolveGroupIpcPath(ctx.sourceGroup),
      'messages',
    );
    writeIpcMessageFile(messagesDir, {
      type: 'message',
      chatJid: ctx.chatJid,
      text,
      groupFolder: ctx.sourceGroup,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: 'Reply delivered.' }],
    };
  };
}

/**
 * Construct the stdio MCP server with the single `host_mcp_reply` tool.
 * Exported for tests that want to inspect registration without running the
 * stdio transport.
 */
export function createHostMcpReplyServer(ctx: HostMcpReplyContext): McpServer {
  const server = new McpServer({
    name: 'nanoclaw_host',
    version: '0.1.0',
  });

  const handler = buildHostMcpReplyHandler(ctx);

  server.registerTool(
    'host_mcp_reply',
    {
      description:
        'Deliver the answer to the user. This is your only write primitive — call it exactly once with the full answer text, then exit. The destination chat and group are baked in; you cannot redirect the reply.',
      inputSchema: hostMcpReplySchema,
    },
    handler,
  );

  return server;
}

async function main(): Promise<void> {
  const [, , sourceGroup, chatJid, requestId] = process.argv;
  const ctx: HostMcpReplyContext = {
    sourceGroup: sourceGroup ?? '',
    chatJid: chatJid ?? '',
    requestId: requestId ?? '',
  };

  const server = createHostMcpReplyServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Guard: only run when executed directly, not when imported by tests.
const isDirectRun =
  process.argv[1] !== undefined &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[host-mcp-reply-server] fatal:', err);
    process.exit(1);
  });
}
