import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import {
  isValidGroupFolder,
  isWithinBase,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, SendFileOpts } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendFile: (
    jid: string,
    filePath: string,
    opts?: SendFileOpts,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  // Spawn seam for host-side `claude -p` processes (host-MCP proxy). Injected
  // so tests can stub without actually forking claude. Default impl in
  // `src/index.ts` wraps `child_process.spawn(CLAUDE_BIN, argv, opts)`.
  spawnHostClaude: (argv: string[], opts: SpawnOptions) => ChildProcess;
}

// Container mounts the group folder at /workspace/group; translate the agent's
// container-relative path back to the host path, rejecting anything outside
// the group's folder so a compromised agent can't exfiltrate arbitrary files.
const CONTAINER_GROUP_MOUNT = '/workspace/group';

function resolveContainerFilePath(
  requested: string,
  sourceGroup: string,
): string | null {
  if (!requested || typeof requested !== 'string') return null;
  const groupHostDir = resolveGroupFolderPath(sourceGroup);

  let relative: string;
  if (requested.startsWith(CONTAINER_GROUP_MOUNT)) {
    relative = requested
      .slice(CONTAINER_GROUP_MOUNT.length)
      .replace(/^\/+/, '');
  } else if (path.isAbsolute(requested)) {
    return null;
  } else {
    relative = requested;
  }

  const resolved = path.resolve(groupHostDir, relative);
  const rel = path.relative(groupHostDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

// PitchBook MCP runs at the host level (Claude Code), not inside containers.
// Agents can trigger `/pitchbook-alerts check <watchlist>` via IPC. Restricted
// to main group to avoid compromised non-main containers burning API quota.
const PITCHBOOK_DEBOUNCE_MS = 5 * 60 * 1000;
const pitchbookLastRun = new Map<string, number>();
const WATCHLIST_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// ---- Host-MCP proxy state (U1) --------------------------------------------
// Generalized host-side MCP query. Container agents dispatch via the
// `run_host_mcp_query` MCP tool (U2) which writes an IPC task file; the
// handler below validates, authz-checks, and spawns a scope-constrained
// `claude -p` session that answers via the `host_mcp_reply` primitive (U8).

// Registry of known scopes. Each scope maps to the MCP tool-name prefixes the
// spawned claude session is allowed to use (enforced at spawn via
// --allowed-tools). Extend this with care — every new scope is a new host-side
// privilege boundary.
const HOST_MCP_SCOPES: Record<string, { allowedToolPrefixes: string[] }> = {
  pitchbook: {
    allowedToolPrefixes: ['mcp__claude_ai_PitchBook_Premium__'],
  },
};

const HOST_MCP_DEBOUNCE_MS = 30_000;
const HOST_MCP_TIMEOUT_MS = 120_000;
const HOST_MCP_KILL_GRACE_MS = 5_000;
const HOST_MCP_MAX_QUESTION_LEN = 4000;
const MAX_CONCURRENT_HOST_MCP = 4;
const MAX_CHILD_OUTPUT_BYTES = 512 * 1024;

const REQUEST_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SCOPE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

// The host-side reply MCP server (U8). `dist/host-mcp-reply-server.js` is the
// normal prod path (daemon runs from `dist/`); dev or test harnesses can
// override with HOST_MCP_REPLY_SERVER_CMD / HOST_MCP_REPLY_SERVER_SCRIPT.
const HOST_MCP_REPLY_SERVER_CMD =
  process.env.HOST_MCP_REPLY_SERVER_CMD || 'node';
const HOST_MCP_REPLY_SERVER_SCRIPT =
  process.env.HOST_MCP_REPLY_SERVER_SCRIPT || 'dist/host-mcp-reply-server.js';

// Exported for test access only (U6). Tests need to observe debounce stamping,
// pre-populate the concurrency map, and reset between cases. Production code
// paths do not read these exports.
export const hostMcpLastRun = new Map<string, number>(); // key: `${sourceGroup}:${scope}`
export const hostMcpActiveChildren = new Map<string, ChildProcess>(); // key: requestId

// Host-only directory for per-spawn `.mcp-config.json` files. NOT bind-mounted
// into any container (verified in `src/container-runner.ts` — only
// `host-mcp-requests/` is mounted). The MCP config registers the host-side
// reply server with `sourceGroup`/`chatJid`/`requestId` baked into argv; if a
// container could overwrite this file it could inject arbitrary `mcpServers`
// entries and achieve host code execution. Keeping the config outside the
// container's filesystem namespace eliminates that race.
const HOST_MCP_CONFIG_DIR = path.join(DATA_DIR, 'host-mcp-configs');

function ensureHostMcpConfigDir(): void {
  fs.mkdirSync(HOST_MCP_CONFIG_DIR, { recursive: true });
  try {
    fs.chmodSync(HOST_MCP_CONFIG_DIR, 0o700);
  } catch {
    /* best-effort — chmod can fail on some filesystems (e.g. CI tmpfs) */
  }
}

// Test-only helper: clears module-scope host-MCP state so each test starts
// from a clean slate. Safe to call from production code paths but intended
// only for `beforeEach` in unit tests.
export function _resetHostMcpState(): void {
  hostMcpLastRun.clear();
  hostMcpActiveChildren.clear();
}

// Returns true if the group is trusted to invoke the given action name.
// Main groups bypass the trustedHostActions list (they're trusted by default).
// Used by `pitchbook_check` (flat action name) and `host_mcp_query:<scope>`
// (namespaced action name). Exported for unit-test coverage of the authz
// matrix (U6 T16); consumers in this file reference it directly.
export function hasTrustedHostAction(
  reg: RegisteredGroup | undefined,
  action: string,
): boolean {
  return reg?.containerConfig?.trustedHostActions?.includes(action) === true;
}

// Synthesize a plain-text failure reply the user will see in chat. Writes a
// `type: "message"` IPC file atomically (tmp → rename) into the source
// group's messages dir; the IPC watcher picks it up on the next tick and
// routes through the normal send path. Swallows write errors after logging —
// failure-to-notify must not crash the watcher.
function synthesizeFailureReply(
  sourceGroup: string,
  chatJid: string,
  text: string,
): void {
  try {
    if (!isValidGroupFolder(sourceGroup) || !chatJid || !text) return;
    const messagesDir = path.join(resolveGroupIpcPath(sourceGroup), 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const filePath = path.join(messagesDir, filename);
    const tempPath = `${filePath}.tmp`;
    const payload = {
      type: 'message',
      chatJid,
      text,
      groupFolder: sourceGroup,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    logger.error(
      { err, sourceGroup, chatJid },
      'Failed to synthesize failure reply',
    );
  }
}

// Atomic write (tmp → rename) for the host-MCP request descriptor. Mirrors
// the container-side `writeIpcFile` pattern at
// `container/agent-runner/src/ipc-mcp-stdio.ts:23-35`.
function writeHostMcpRequestFile(filePath: string, data: object): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
}

function pitchbookWatchlistExists(slug: string): boolean {
  if (slug === 'all') return true;
  const p = path.join(
    process.cwd(),
    'data',
    'pitchbook',
    'watchlists',
    `${slug}.json`,
  );
  return fs.existsSync(p);
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                data.type === 'file_upload' &&
                data.chatJid &&
                data.filePath
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                const authorized =
                  isMain || (targetGroup && targetGroup.folder === sourceGroup);
                if (!authorized) {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC file upload blocked',
                  );
                } else {
                  const hostPath = resolveContainerFilePath(
                    data.filePath,
                    sourceGroup,
                  );
                  if (!hostPath) {
                    logger.warn(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        requested: data.filePath,
                      },
                      'IPC file upload rejected: path escapes group folder',
                    );
                  } else if (!fs.existsSync(hostPath)) {
                    logger.warn(
                      { chatJid: data.chatJid, sourceGroup, hostPath },
                      'IPC file upload rejected: file not found',
                    );
                  } else {
                    await deps.sendFile(data.chatJid, hostPath, {
                      title: data.title,
                      initialComment: data.initialComment,
                    });
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup, hostPath },
                      'IPC file uploaded',
                    );
                  }
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For pitchbook_check
    watchlist?: string;
    // For host_mcp_query
    scope?: string;
    question?: string;
    requestId?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'pitchbook_check': {
      const sourceReg = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup,
      );
      if (!isMain && !hasTrustedHostAction(sourceReg, 'pitchbook_check')) {
        logger.warn(
          { sourceGroup },
          'Unauthorized pitchbook_check attempt blocked',
        );
        break;
      }
      const slug = (data.watchlist || '').trim();
      if (!slug || (slug !== 'all' && !WATCHLIST_SLUG_PATTERN.test(slug))) {
        logger.warn(
          { sourceGroup, slug },
          'pitchbook_check rejected: invalid watchlist slug',
        );
        break;
      }
      if (!pitchbookWatchlistExists(slug)) {
        logger.warn(
          { sourceGroup, slug },
          'pitchbook_check rejected: watchlist not found',
        );
        break;
      }
      const now = Date.now();
      const last = pitchbookLastRun.get(slug) || 0;
      if (now - last < PITCHBOOK_DEBOUNCE_MS) {
        logger.warn(
          {
            sourceGroup,
            slug,
            sinceLastMs: now - last,
            debounceMs: PITCHBOOK_DEBOUNCE_MS,
          },
          'pitchbook_check debounced',
        );
        break;
      }
      pitchbookLastRun.set(slug, now);
      logger.info(
        { sourceGroup, slug },
        'Spawning pitchbook-alerts check via claude CLI',
      );
      const child = spawn(
        CLAUDE_BIN,
        [
          '-p',
          '--dangerously-skip-permissions',
          `/pitchbook-alerts check ${slug}`,
        ],
        {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (c) => {
        stdout += c.toString();
      });
      child.stderr?.on('data', (c) => {
        stderr += c.toString();
      });
      child.on('exit', (code) => {
        logger.info(
          { slug, code, stdoutLen: stdout.length, stderrLen: stderr.length },
          'pitchbook-alerts check finished',
        );
        if (code !== 0) {
          logger.warn(
            { slug, stderr: stderr.slice(0, 2000) },
            'pitchbook-alerts check failed',
          );
        }
      });
      child.on('error', (err) => {
        logger.error(
          { slug, err },
          'Failed to spawn claude for pitchbook-alerts',
        );
      });
      break;
    }

    case 'host_mcp_query': {
      // Generalized host-MCP proxy. Container agents call
      // `run_host_mcp_query(scope, question)` (U2) which writes a task file
      // that lands here. The handler validates every untrusted field, gates
      // on authz / concurrency / debounce, then spawns a scope-constrained
      // `claude -p` session. The spawned session uses the `host_mcp_reply`
      // MCP tool (U8) to deliver its answer; this handler ONLY narrates
      // failures — never synthesizes a success reply.
      const scope = data.scope ?? '';
      const question = data.question ?? '';
      const requestId = data.requestId ?? '';
      const chatJid = data.chatJid ?? '';

      const reject = (msg: string): void => {
        synthesizeFailureReply(sourceGroup, chatJid, msg);
        logger.warn(
          { requestId, scope, sourceGroup },
          `host_mcp_query rejected: ${msg}`,
        );
      };

      // (1) Shape-validate all untrusted fields before touching the filesystem
      //     or spawning anything. Fast-fail on any shape violation.
      if (
        !SCOPE_NAME_PATTERN.test(scope) ||
        !REQUEST_ID_PATTERN.test(requestId) ||
        !isValidGroupFolder(sourceGroup) ||
        typeof question !== 'string' ||
        question.length === 0 ||
        question.length > HOST_MCP_MAX_QUESTION_LEN ||
        typeof chatJid !== 'string' ||
        chatJid.length === 0
      ) {
        reject('Invalid request format.');
        break;
      }

      // (2) Registry own-property check (prototype-pollution-safe).
      if (!Object.prototype.hasOwnProperty.call(HOST_MCP_SCOPES, scope)) {
        reject(`Unknown scope: ${scope}.`);
        break;
      }

      // (3) Authz: main groups bypass; non-main must have the namespaced
      //     `host_mcp_query:<scope>` action in trustedHostActions.
      const sourceReg = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup,
      );
      if (
        !isMain &&
        !hasTrustedHostAction(sourceReg, `host_mcp_query:${scope}`)
      ) {
        reject('Not authorized to call this scope.');
        break;
      }

      // (4) Concurrency cap.
      if (hostMcpActiveChildren.size >= MAX_CONCURRENT_HOST_MCP) {
        reject('Host-MCP proxy is busy; try again shortly.');
        break;
      }

      // (5) Debounce gate (check only — stamp AFTER spawn success so failed
      //     spawns don't consume the user's debounce budget).
      const debounceKey = `${sourceGroup}:${scope}`;
      const now = Date.now();
      const last = hostMcpLastRun.get(debounceKey) ?? 0;
      if (now - last < HOST_MCP_DEBOUNCE_MS) {
        reject("You're asking too fast — try again in a few seconds.");
        break;
      }

      // (6) Safe path construction. REQUEST_ID_PATTERN already restricts to
      //     UUID-v4 shape, so this is defense-in-depth.
      const hostMcpBase = path.join(
        resolveGroupIpcPath(sourceGroup),
        'host-mcp-requests',
      );
      const requestPath = path.join(hostMcpBase, `${requestId}.json`);
      if (!isWithinBase(hostMcpBase, requestPath)) {
        reject('Invalid request identifier.');
        break;
      }

      // (7) Write the request descriptor atomically; the host-mcp-agent skill
      //     (U4) reads it by path.
      try {
        writeHostMcpRequestFile(requestPath, {
          question,
          chatJid,
          sourceGroup,
          scope,
        });
      } catch (err) {
        logger.error(
          { err, requestId, scope, sourceGroup },
          'host_mcp_query: failed to write request file',
        );
        reject('Could not stage host-MCP request.');
        break;
      }

      // (8) Spawn the host-side claude with a locked-down tool allowlist.
      //     The scope's allowed prefixes are suffixed with `*` so they match
      //     any tool in that MCP server; the reply primitive (U8) is the
      //     only write path the agent has.
      const scopeDef = HOST_MCP_SCOPES[scope];
      const allowedTools = [
        ...scopeDef.allowedToolPrefixes.map((p) => `${p}*`),
        'mcp__nanoclaw_host__host_mcp_reply',
      ].join(',');

      // (8a) Per-spawn MCP config (U8). Registers the host-side reply MCP
      //      server with `sourceGroup`, `chatJid`, and `requestId` baked into
      //      its positional argv — the agent cannot override these since
      //      they're argv to the server, not tool parameters. File is
      //      unlinked alongside the request descriptor on child exit.
      //
      //      SECURITY: this config lives in `data/host-mcp-configs/` which is
      //      NOT bind-mounted into any container (see `src/container-runner.ts`).
      //      A prompt-injected container CANNOT race-overwrite this file to
      //      inject malicious `mcpServers` entries — the path is outside the
      //      container's filesystem namespace. The request descriptor
      //      (`<id>.json`) stays inside `host-mcp-requests/` because the host
      //      skill reads it from there; only the authority-bearing config is
      //      moved.
      ensureHostMcpConfigDir();
      const mcpConfigPath = path.join(
        HOST_MCP_CONFIG_DIR,
        `${requestId}.mcp-config.json`,
      );
      if (!isWithinBase(HOST_MCP_CONFIG_DIR, mcpConfigPath)) {
        try {
          fs.unlinkSync(requestPath);
        } catch {
          /* ENOENT ok */
        }
        reject('Invalid request identifier.');
        break;
      }
      const mcpConfig = {
        mcpServers: {
          nanoclaw_host: {
            command: HOST_MCP_REPLY_SERVER_CMD,
            args: [
              HOST_MCP_REPLY_SERVER_SCRIPT,
              sourceGroup,
              chatJid,
              requestId,
            ],
          },
        },
      };
      try {
        writeHostMcpRequestFile(mcpConfigPath, mcpConfig);
      } catch (err) {
        try {
          fs.unlinkSync(requestPath);
        } catch {
          /* ENOENT ok */
        }
        logger.error(
          { err, requestId, scope, sourceGroup },
          'host_mcp_query: failed to write MCP config file',
        );
        reject('Could not stage host-MCP request.');
        break;
      }

      const argv = [
        '-p',
        '--dangerously-skip-permissions',
        '--allowed-tools',
        allowedTools,
        '--mcp-config',
        mcpConfigPath,
        `/host-mcp-agent ${scope} ${sourceGroup} ${requestId}`,
      ];

      logger.info(
        { requestId, scope, sourceGroup },
        'Spawning host-mcp-agent via claude CLI',
      );

      let child: ChildProcess;
      try {
        child = deps.spawnHostClaude(argv, {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        // Synchronous spawn failure (e.g., CLAUDE_BIN missing).
        try {
          fs.unlinkSync(requestPath);
        } catch {
          /* ENOENT ok */
        }
        try {
          fs.unlinkSync(mcpConfigPath);
        } catch {
          /* ENOENT ok */
        }
        logger.error(
          { err, requestId, scope, sourceGroup },
          'host_mcp_query: spawn threw synchronously',
        );
        reject('Could not start host-MCP query.');
        break;
      }

      // (9) Stamp debounce SYNCHRONOUSLY now that spawn has returned without
      //     throwing. The IPC watcher serializes task processing, but each
      //     handler returns before any 'spawn' event fires — stamping in the
      //     async event handler would let bursts up to the concurrency cap
      //     ALL bypass debounce. The 'error' path below rolls this back.
      hostMcpLastRun.set(debounceKey, Date.now());

      // (10) Track the child for concurrency accounting and timeout cleanup.
      hostMcpActiveChildren.set(requestId, child);

      // (11) Bounded output buffering. After the cap, set a `truncated` flag
      //      and drop further chunks — prevents a runaway child from
      //      exhausting host memory via stdout/stderr.
      const buf = { stdout: '', stderr: '', truncated: false };
      const append =
        (stream: 'stdout' | 'stderr') =>
        (chunk: Buffer): void => {
          const s = chunk.toString();
          if (buf[stream].length + s.length > MAX_CHILD_OUTPUT_BYTES) {
            buf.truncated = true;
            return;
          }
          buf[stream] += s;
        };
      child.stdout?.on('data', append('stdout'));
      child.stderr?.on('data', append('stderr'));

      // (12) Two-step timeout: SIGTERM first, then SIGKILL after a grace
      //      window. The soft timer also synthesizes the timeout reply so
      //      the user sees a message even if the child exits cleanly after.
      //      Declared before the 'error' listener so its cleanup branch can
      //      reference them; `cleanedUp` makes cleanup idempotent across the
      //      'error' / 'exit' race (per Node semantics, 'exit' may or may
      //      not fire after 'error').
      let cleanedUp = false;
      let killTimer: NodeJS.Timeout | undefined;
      const softTimer: NodeJS.Timeout = setTimeout(() => {
        synthesizeFailureReply(
          sourceGroup,
          chatJid,
          `${scope} query timed out after ${HOST_MCP_TIMEOUT_MS / 1000}s.`,
        );
        try {
          child.kill('SIGTERM');
        } catch (err) {
          logger.warn({ err, requestId }, 'host_mcp_query: SIGTERM failed');
        }
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch (err) {
            logger.warn({ err, requestId }, 'host_mcp_query: SIGKILL failed');
          }
        }, HOST_MCP_KILL_GRACE_MS);
      }, HOST_MCP_TIMEOUT_MS);

      const performCleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearTimeout(softTimer);
        if (killTimer) clearTimeout(killTimer);
        hostMcpActiveChildren.delete(requestId);
        try {
          fs.unlinkSync(requestPath);
        } catch {
          /* ENOENT ok — already gone */
        }
        try {
          fs.unlinkSync(mcpConfigPath);
        } catch {
          /* ENOENT ok — already gone */
        }
      };

      // (13) Async spawn failure (e.g. ENOENT after fork). Per Node semantics
      //      'exit' may not fire after 'error', so this handler must perform
      //      full cleanup itself: clear timers, drop the map entry, unlink
      //      both files, and roll back the debounce stamp so the failed
      //      spawn doesn't consume the user's debounce budget. `cleanedUp`
      //      guards against the race where 'exit' fires later anyway.
      child.on('error', (err) => {
        if (cleanedUp) {
          logger.warn(
            { err, requestId },
            'host_mcp_query: error after cleanup (ignored)',
          );
          return;
        }
        hostMcpLastRun.delete(debounceKey);
        performCleanup();
        logger.error(
          { err, requestId, scope, sourceGroup },
          'host_mcp_query: spawn failure',
        );
        synthesizeFailureReply(
          sourceGroup,
          chatJid,
          'Could not start host-MCP query.',
        );
      });

      // (14) Exit cleanup. try/finally ensures the map entry and request
      //      file are cleaned up even if logger throws. Do NOT synthesize
      //      a success reply — that's the host_mcp_reply tool's job (U8).
      //      `performCleanup` is idempotent against the 'error'-then-'exit'
      //      race.
      const spawnedAt = Date.now();
      child.on('exit', (code, signal) => {
        try {
          logger.info(
            {
              requestId,
              scope,
              sourceGroup,
              code,
              signal,
              stdoutLen: buf.stdout.length,
              stderrLen: buf.stderr.length,
              truncated: buf.truncated,
              durationMs: Date.now() - spawnedAt,
            },
            'host_mcp_query exit',
          );
        } finally {
          performCleanup();
        }
      });
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
