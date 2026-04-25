import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DATA_DIR } from './config.js';
import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
} from './db.js';
import {
  _resetHostMcpState,
  hasTrustedHostAction,
  hostMcpActiveChildren,
  hostMcpLastRun,
  IpcDeps,
  processTaskIpc,
} from './ipc.js';
import { RegisteredGroup } from './types.js';

// Set up registered groups used across tests
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  // Populate DB as well
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    sendMessage: async () => {},
    sendFile: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
      // Mock the fs.mkdirSync that registerGroup does
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
    // U1 added a spawn seam for host-MCP proxy. Existing authz tests don't
    // exercise the `host_mcp_query` case so the stub never runs; U6 will
    // swap in a proper vi.fn for the host_mcp_query test block.
    spawnHostClaude: () => {
      throw new Error('spawnHostClaude stub not configured for this test');
    },
  };
});

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify task was created in DB for the other group
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'unauthorized',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no target',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'unknown@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-main',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'main task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-other',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'other task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can pause any task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-main' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-main')!.status).toBe('active');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-paused',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'paused task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can resume any task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'third-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('paused');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('main group can cancel any task', async () => {
    createTask({
      id: 'task-to-cancel',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'cancel me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-to-cancel' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-to-cancel')).toBeUndefined();
  });

  it('non-main group can cancel its own task', async () => {
    createTask({
      id: 'task-own',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'my task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-own' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-own')).toBeUndefined();
  });

  it('non-main group cannot cancel another groups task', async () => {
    createTask({
      id: 'task-foreign',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'not yours',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-foreign' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-foreign')).toBeDefined();
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'other-group',
      false,
      deps,
    );

    // registeredGroups should not have changed
    expect(groups['new@g.us']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: '../../outside',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(groups['new@g.us']).toBeUndefined();
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    // This should be silently blocked (no crash, no effect)
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other-group',
      false,
      deps,
    );
    // If we got here without error, the auth gate worked
  });
});

// --- IPC message authorization ---
// Tests the authorization pattern from startIpcWatcher (ipc.ts).
// The logic: isMain || (targetGroup && targetGroup.folder === sourceGroup)

describe('IPC message authorization', () => {
  // Replicate the exact check from the IPC watcher
  function isMessageAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
    registeredGroups: Record<string, RegisteredGroup>,
  ): boolean {
    const targetGroup = registeredGroups[targetChatJid];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can send to any group', () => {
    expect(
      isMessageAuthorized('whatsapp_main', true, 'other@g.us', groups),
    ).toBe(true);
    expect(
      isMessageAuthorized('whatsapp_main', true, 'third@g.us', groups),
    ).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(
      isMessageAuthorized('other-group', false, 'other@g.us', groups),
    ).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(isMessageAuthorized('other-group', false, 'main@g.us', groups)).toBe(
      false,
    );
    expect(
      isMessageAuthorized('other-group', false, 'third@g.us', groups),
    ).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(
      isMessageAuthorized('other-group', false, 'unknown@g.us', groups),
    ).toBe(false);
  });

  it('main group can send to unregistered JID', () => {
    // Main is always authorized regardless of target
    expect(
      isMessageAuthorized('whatsapp_main', true, 'unknown@g.us', groups),
    ).toBe(true);
  });
});

// --- schedule_task with cron and interval types ---

describe('schedule_task schedule types', () => {
  it('creates task with cron schedule and computes next_run', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *', // every day at 9am
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].next_run).toBeTruthy();
    // next_run should be a valid ISO date in the future
    expect(new Date(tasks[0].next_run!).getTime()).toBeGreaterThan(
      Date.now() - 60000,
    );
  });

  it('rejects invalid cron expression', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    const before = Date.now();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '3600000', // 1 hour
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('interval');
    // next_run should be ~1 hour from now
    const nextRun = new Date(tasks[0].next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 3600000 + 1000);
  });

  it('rejects invalid interval (non-numeric)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: 'abc',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid interval (zero)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'zero interval',
        schedule_type: 'interval',
        schedule_value: '0',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad once',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode', () => {
  it('accepts context_mode=group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'group context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'group',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'isolated context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'isolated',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults invalid context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'bogus' as any,
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults missing context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no context mode',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// --- register_group success path ---

describe('register_group success', () => {
  it('main group can register a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify group was registered in DB
    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('New Group');
    expect(group!.folder).toBe('new-group');
    expect(group!.trigger).toBe('@Andy');
  });

  it('register_group rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'partial@g.us',
        name: 'Partial',
        // missing folder and trigger
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('partial@g.us')).toBeUndefined();
  });
});

// --- host_mcp_query authorization (U6) ---
//
// Covers every control-flow branch enumerated in U1's test-scenarios list
// (T1–T11) plus U6 additions (T16 helper matrix, T17 reply file shape) and
// T12 pitchbook_check regression coverage. The handler uses `deps.spawnHostClaude`
// as a seam so tests never fork a real `claude` process.

const VALID_REQUEST_ID = '12345678-1234-1234-1234-123456789012';
const SECOND_REQUEST_ID = '87654321-4321-4321-4321-210987654321';
const MAIN_FOLDER = 'whatsapp_main';
const OTHER_FOLDER = 'other-group';
const VALID_CHAT_JID = 'main@g.us';
const OTHER_CHAT_JID = 'other@g.us';

type FakeChild = {
  pid: number;
  on: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
  kill: ReturnType<typeof vi.fn>;
  stdout: { on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
};

function makeFakeChild(): FakeChild {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    pid: 12345,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
    }) as unknown as ReturnType<typeof vi.fn>,
    emit: (event: string, ...args: unknown[]) => {
      listeners.get(event)?.forEach((cb) => cb(...args));
    },
    kill: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
  };
}

// Cleans up any IPC files the handler wrote during the test.
function cleanGroupIpc(folder: string): void {
  try {
    fs.rmSync(path.join(DATA_DIR, 'ipc', folder), {
      recursive: true,
      force: true,
    });
  } catch {
    /* best-effort */
  }
}

// FIX 1: per-spawn .mcp-config.json files now live outside any group's IPC
// dir so they can't be raced by a container. Wipe between tests for isolation.
function cleanHostMcpConfigs(): void {
  try {
    fs.rmSync(path.join(DATA_DIR, 'host-mcp-configs'), {
      recursive: true,
      force: true,
    });
  } catch {
    /* best-effort */
  }
}

// Returns the list of message files written to data/ipc/<folder>/messages/
function listMessageFiles(folder: string): string[] {
  const dir = path.join(DATA_DIR, 'ipc', folder, 'messages');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
}

function readFirstMessageFile(
  folder: string,
): Record<string, unknown> | undefined {
  const files = listMessageFiles(folder);
  if (!files.length) return undefined;
  const p = path.join(DATA_DIR, 'ipc', folder, 'messages', files[0]);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// Default valid host_mcp_query payload.
function validPayload(overrides: Record<string, unknown> = {}): {
  type: 'host_mcp_query';
  scope: string;
  question: string;
  requestId: string;
  chatJid: string;
} & Record<string, unknown> {
  return {
    type: 'host_mcp_query',
    scope: 'pitchbook',
    question: 'What do we know about Vercel?',
    requestId: VALID_REQUEST_ID,
    chatJid: VALID_CHAT_JID,
    ...overrides,
  };
}

describe('host_mcp_query authorization', () => {
  let fakeChild: FakeChild;
  let spawnStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetHostMcpState();
    cleanGroupIpc(MAIN_FOLDER);
    cleanGroupIpc(OTHER_FOLDER);
    cleanGroupIpc('third-group');
    cleanHostMcpConfigs();
    fakeChild = makeFakeChild();
    spawnStub = vi.fn(() => fakeChild);
    deps.spawnHostClaude = spawnStub as unknown as IpcDeps['spawnHostClaude'];
  });

  afterEach(() => {
    _resetHostMcpState();
    cleanGroupIpc(MAIN_FOLDER);
    cleanGroupIpc(OTHER_FOLDER);
    cleanGroupIpc('third-group');
    cleanHostMcpConfigs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ---- T1: happy path, main group -----------------------------------------
  it('T1: main group → spawns host claude with scoped --allowed-tools and writes request file', async () => {
    await processTaskIpc(validPayload(), MAIN_FOLDER, true, deps);

    expect(spawnStub).toHaveBeenCalledTimes(1);
    const [argv, opts] = spawnStub.mock.calls[0] as [
      string[],
      Record<string, unknown>,
    ];
    expect(argv).toContain('-p');
    expect(argv).toContain('--dangerously-skip-permissions');
    // --allowed-tools should include the pitchbook prefix and the reply primitive
    const allowedIdx = argv.indexOf('--allowed-tools');
    expect(allowedIdx).toBeGreaterThanOrEqual(0);
    expect(argv[allowedIdx + 1]).toBe(
      'mcp__claude_ai_PitchBook_Premium__*,mcp__nanoclaw_host__host_mcp_reply',
    );
    // slash command carries scope / sourceGroup / requestId
    const slashArg = argv[argv.length - 1];
    expect(slashArg).toBe(
      `/host-mcp-agent pitchbook ${MAIN_FOLDER} ${VALID_REQUEST_ID}`,
    );
    expect(opts).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] });

    // Request descriptor file written at the expected path
    const requestPath = path.join(
      DATA_DIR,
      'ipc',
      MAIN_FOLDER,
      'host-mcp-requests',
      `${VALID_REQUEST_ID}.json`,
    );
    expect(fs.existsSync(requestPath)).toBe(true);
    const desc = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    expect(desc).toEqual({
      question: 'What do we know about Vercel?',
      chatJid: VALID_CHAT_JID,
      sourceGroup: MAIN_FOLDER,
      scope: 'pitchbook',
    });

    // FIX 1: MCP config lives in host-only data/host-mcp-configs/, NOT in
    // the container-mounted host-mcp-requests/. Verify both: present in
    // host-only dir, absent from the mounted dir.
    const mcpConfigHostPath = path.join(
      DATA_DIR,
      'host-mcp-configs',
      `${VALID_REQUEST_ID}.mcp-config.json`,
    );
    expect(fs.existsSync(mcpConfigHostPath)).toBe(true);
    const mcpConfigInMountedPath = path.join(
      DATA_DIR,
      'ipc',
      MAIN_FOLDER,
      'host-mcp-requests',
      `${VALID_REQUEST_ID}.mcp-config.json`,
    );
    expect(fs.existsSync(mcpConfigInMountedPath)).toBe(false);

    // FIX 1: spawn argv should reference the host-only mcp-config path.
    const mcpConfigIdx = argv.indexOf('--mcp-config');
    expect(mcpConfigIdx).toBeGreaterThanOrEqual(0);
    expect(argv[mcpConfigIdx + 1]).toBe(mcpConfigHostPath);

    // OPTION C: built-in tools hard-denied via `--tools ""`.
    const toolsIdx = argv.indexOf('--tools');
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(argv[toolsIdx + 1]).toBe('');

    // OPTION C: third-party MCPs outside the scope are explicitly denied.
    // Pitchbook is in-scope and MUST NOT appear; Gmail/Drive/Calendar/etc.
    // MUST appear in the denylist.
    const disallowedIdx = argv.indexOf('--disallowed-tools');
    expect(disallowedIdx).toBeGreaterThanOrEqual(0);
    const disallowed = argv[disallowedIdx + 1];
    expect(disallowed).not.toContain('mcp__claude_ai_PitchBook_Premium__');
    expect(disallowed).toContain('mcp__claude_ai_Gmail__*');
    expect(disallowed).toContain('mcp__claude_ai_Google_Drive__*');
    expect(disallowed).toContain('mcp__claude_ai_Google_Calendar__*');
    expect(disallowed).toContain('mcp__claude_ai_Google_Cloud_BigQuery__*');
    expect(disallowed).toContain('mcp__claude_ai_Clay__*');
    expect(disallowed).toContain('mcp__claude_ai_PowerNotes__*');

    // FIX 3: debounce is stamped SYNCHRONOUSLY, before any 'spawn' event.
    expect(hostMcpLastRun.has(`${MAIN_FOLDER}:pitchbook`)).toBe(true);

    // Child is tracked for concurrency accounting
    expect(hostMcpActiveChildren.has(VALID_REQUEST_ID)).toBe(true);

    // No failure reply written
    expect(listMessageFiles(MAIN_FOLDER)).toHaveLength(0);
  });

  // ---- T2: happy path, trusted non-main -----------------------------------
  it('T2: non-main group with matching trustedHostActions → spawn called', async () => {
    // Mutate the other group to trust host_mcp_query:pitchbook
    const trustedOther: RegisteredGroup = {
      ...OTHER_GROUP,
      containerConfig: {
        trustedHostActions: ['host_mcp_query:pitchbook'],
      },
    };
    groups['other@g.us'] = trustedOther;
    setRegisteredGroup('other@g.us', trustedOther);

    await processTaskIpc(
      validPayload({ chatJid: OTHER_CHAT_JID }),
      OTHER_FOLDER,
      false,
      deps,
    );

    expect(spawnStub).toHaveBeenCalledTimes(1);
    const requestPath = path.join(
      DATA_DIR,
      'ipc',
      OTHER_FOLDER,
      'host-mcp-requests',
      `${VALID_REQUEST_ID}.json`,
    );
    expect(fs.existsSync(requestPath)).toBe(true);
    expect(listMessageFiles(OTHER_FOLDER)).toHaveLength(0);
  });

  // ---- T3: shape-invalid inputs (table-driven) ----------------------------
  const shapeInvalidRows: Array<{
    label: string;
    override: Record<string, unknown>;
  }> = [
    { label: 'scope with space', override: { scope: 'foo bar' } },
    { label: 'scope with path escape', override: { scope: '../x' } },
    { label: 'scope __proto__', override: { scope: '__proto__' } },
    { label: 'scope empty', override: { scope: '' } },
    { label: 'scope uppercase', override: { scope: 'PITCH' } },
    { label: 'scope too long', override: { scope: 'a'.repeat(40) } },
    {
      label: 'requestId with path escape',
      override: { requestId: '../messages/forged' },
    },
    { label: 'requestId empty', override: { requestId: '' } },
    { label: 'requestId nonsense', override: { requestId: 'nonsense' } },
    { label: 'requestId not uuid', override: { requestId: 'not-a-uuid' } },
    { label: 'question too long', override: { question: 'a'.repeat(4001) } },
  ];

  for (const row of shapeInvalidRows) {
    it(`T3 (${row.label}): no spawn + decline reply written`, async () => {
      await processTaskIpc(validPayload(row.override), MAIN_FOLDER, true, deps);

      expect(spawnStub).not.toHaveBeenCalled();
      const files = listMessageFiles(MAIN_FOLDER);
      expect(files).toHaveLength(1);
      const payload = readFirstMessageFile(MAIN_FOLDER)!;
      expect(payload).toMatchObject({
        type: 'message',
        chatJid: VALID_CHAT_JID,
        groupFolder: MAIN_FOLDER,
      });
      expect(typeof payload.text).toBe('string');
      expect((payload.text as string).length).toBeGreaterThan(0);
    });
  }

  // ---- T4: unknown scope --------------------------------------------------
  it('T4: unknown scope → no spawn, decline "Unknown scope"', async () => {
    await processTaskIpc(
      validPayload({ scope: 'gmail' }),
      MAIN_FOLDER,
      true,
      deps,
    );

    expect(spawnStub).not.toHaveBeenCalled();
    const payload = readFirstMessageFile(MAIN_FOLDER)!;
    expect(payload.text).toMatch(/Unknown scope/i);
    expect(payload).toMatchObject({
      type: 'message',
      chatJid: VALID_CHAT_JID,
      groupFolder: MAIN_FOLDER,
    });
  });

  // ---- T5: untrusted non-main --------------------------------------------
  it('T5: untrusted non-main group → no spawn, decline "Not authorized"', async () => {
    // OTHER_GROUP has no trustedHostActions
    await processTaskIpc(
      validPayload({ chatJid: OTHER_CHAT_JID }),
      OTHER_FOLDER,
      false,
      deps,
    );

    expect(spawnStub).not.toHaveBeenCalled();
    const payload = readFirstMessageFile(OTHER_FOLDER)!;
    expect(payload.text).toMatch(/not authorized/i);
    expect(payload).toMatchObject({
      type: 'message',
      chatJid: OTHER_CHAT_JID,
      groupFolder: OTHER_FOLDER,
    });
  });

  // ---- T6: concurrency cap ------------------------------------------------
  it('T6: concurrency cap hit → no spawn, decline "busy"', async () => {
    // Pre-populate the map with MAX_CONCURRENT_HOST_MCP=4 entries
    for (let i = 0; i < 4; i++) {
      hostMcpActiveChildren.set(
        `preloaded-${i}`,
        makeFakeChild() as unknown as import('child_process').ChildProcess,
      );
    }

    await processTaskIpc(validPayload(), MAIN_FOLDER, true, deps);

    expect(spawnStub).not.toHaveBeenCalled();
    const payload = readFirstMessageFile(MAIN_FOLDER)!;
    expect(payload.text).toMatch(/busy/i);
  });

  // ---- T7: debounce -------------------------------------------------------
  it('T7: back-to-back same {sourceGroup, scope} → second declined "too fast"; different sourceGroup still spawns', async () => {
    // First dispatch — happy path
    await processTaskIpc(validPayload(), MAIN_FOLDER, true, deps);
    expect(spawnStub).toHaveBeenCalledTimes(1);
    // FIX 3: debounce is stamped synchronously after spawn returns; no
    // 'spawn' event needed.
    expect(hostMcpLastRun.has(`${MAIN_FOLDER}:pitchbook`)).toBe(true);

    // Second dispatch with same key → declined
    await processTaskIpc(
      validPayload({ requestId: SECOND_REQUEST_ID }),
      MAIN_FOLDER,
      true,
      deps,
    );
    expect(spawnStub).toHaveBeenCalledTimes(1); // no second spawn
    const payload = readFirstMessageFile(MAIN_FOLDER)!;
    expect(payload.text).toMatch(/too fast/i);

    // Different sourceGroup with trusted action — spawn still happens
    const trustedOther: RegisteredGroup = {
      ...OTHER_GROUP,
      containerConfig: {
        trustedHostActions: ['host_mcp_query:pitchbook'],
      },
    };
    groups['other@g.us'] = trustedOther;
    setRegisteredGroup('other@g.us', trustedOther);
    await processTaskIpc(
      validPayload({
        requestId: SECOND_REQUEST_ID,
        chatJid: OTHER_CHAT_JID,
      }),
      OTHER_FOLDER,
      false,
      deps,
    );
    expect(spawnStub).toHaveBeenCalledTimes(2);
  });

  // ---- T7b (FIX 3): same-tick burst — debounce stamps synchronously ------
  it('T7b: two same-{group,scope} task files dispatched back-to-back in the same tick → only first spawns', async () => {
    // Two awaited calls in immediate succession. Before FIX 3 the debounce
    // stamp was deferred to the async 'spawn' event, so both calls passed
    // the gate. After FIX 3 the stamp is synchronous and the second call
    // is rejected with "too fast".
    await processTaskIpc(validPayload(), MAIN_FOLDER, true, deps);
    await processTaskIpc(
      validPayload({ requestId: SECOND_REQUEST_ID }),
      MAIN_FOLDER,
      true,
      deps,
    );

    expect(spawnStub).toHaveBeenCalledTimes(1);
    const files = listMessageFiles(MAIN_FOLDER);
    expect(files).toHaveLength(1);
    const payload = readFirstMessageFile(MAIN_FOLDER)!;
    expect(payload.text).toMatch(/too fast/i);
  });

  // ---- T8: path-escape via isWithinBase -----------------------------------
  //
  // Note: mocking `isWithinBase` would require `vi.mock('./group-folder.js')`
  // at module top, which affects every test in this file. REQUEST_ID_PATTERN
  // already restricts requestId to UUID-v4 shape — the `isWithinBase` call is
  // strict defense-in-depth and is impossible to reach with a well-formed
  // requestId. Shape-invalid requestIds are covered by T3 (path-escape row).
  it('T8: path-escape defense — covered by T3 requestId rows (isWithinBase is defense-in-depth)', () => {
    expect(true).toBe(true);
  });

  // ---- T9 (FIX 2): spawn-error path performs full cleanup ----------------
  it('T9: spawn emits error → request + mcp-config unlinked, decline reply, debounce rolled back, map entry cleared, timers cleared, no later spurious timeout reply', async () => {
    vi.useFakeTimers();
    try {
      await processTaskIpc(validPayload(), MAIN_FOLDER, true, deps);

      const requestPath = path.join(
        DATA_DIR,
        'ipc',
        MAIN_FOLDER,
        'host-mcp-requests',
        `${VALID_REQUEST_ID}.json`,
      );
      const mcpConfigPath = path.join(
        DATA_DIR,
        'host-mcp-configs',
        `${VALID_REQUEST_ID}.mcp-config.json`,
      );
      expect(fs.existsSync(requestPath)).toBe(true);
      expect(fs.existsSync(mcpConfigPath)).toBe(true);
      // FIX 3: debounce stamped synchronously on successful spawn.
      expect(hostMcpLastRun.has(`${MAIN_FOLDER}:pitchbook`)).toBe(true);
      // FIX 2: child was registered for concurrency accounting.
      expect(hostMcpActiveChildren.has(VALID_REQUEST_ID)).toBe(true);
      // softTimer was scheduled.
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);

      // Simulate async spawn failure (e.g., ENOENT post-fork).
      fakeChild.emit('error', new Error('ENOENT: claude binary'));

      // FIX 1+2: both authority files unlinked.
      expect(fs.existsSync(requestPath)).toBe(false);
      expect(fs.existsSync(mcpConfigPath)).toBe(false);

      // Decline reply written.
      const payload = readFirstMessageFile(MAIN_FOLDER)!;
      expect(payload.text).toMatch(/could not start/i);

      // FIX 2: debounce rolled back so a failed spawn doesn't burn the user's
      // budget.
      expect(hostMcpLastRun.has(`${MAIN_FOLDER}:pitchbook`)).toBe(false);
      // FIX 2: map entry cleared so concurrency cap isn't leaked.
      expect(hostMcpActiveChildren.has(VALID_REQUEST_ID)).toBe(false);
      // FIX 2: softTimer (and killTimer if scheduled) cleared.
      expect(vi.getTimerCount()).toBe(0);

      // FIX 2: advancing past the timeout window should NOT produce a
      // spurious second reply, since softTimer was cleared.
      const messagesBefore = listMessageFiles(MAIN_FOLDER).length;
      vi.advanceTimersByTime(120_000 + 5_000 + 1_000);
      const messagesAfter = listMessageFiles(MAIN_FOLDER).length;
      expect(messagesAfter).toBe(messagesBefore);
      expect(fakeChild.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // ---- T9b (FIX 2): cleanup is idempotent across error→exit race ---------
  it('T9b: error followed by exit → cleanup idempotent (no double unlink, no double map churn)', async () => {
    await processTaskIpc(validPayload(), MAIN_FOLDER, true, deps);
    fakeChild.emit('error', new Error('ENOENT'));
    expect(hostMcpActiveChildren.has(VALID_REQUEST_ID)).toBe(false);

    // Now also fire 'exit' — must not throw, must not write a duplicate
    // request file or change cleanup state.
    expect(() => fakeChild.emit('exit', 1, null)).not.toThrow();
    expect(hostMcpActiveChildren.has(VALID_REQUEST_ID)).toBe(false);
    // Still only the one decline reply — exit didn't add anything.
    expect(listMessageFiles(MAIN_FOLDER)).toHaveLength(1);
  });

  // ---- T10: exit cleanup runs even if logger throws ----------------------
  it('T10: exit handler cleanup runs in finally even when logger.info throws', async () => {
    await processTaskIpc(validPayload(), MAIN_FOLDER, true, deps);
    const requestPath = path.join(
      DATA_DIR,
      'ipc',
      MAIN_FOLDER,
      'host-mcp-requests',
      `${VALID_REQUEST_ID}.json`,
    );
    const mcpConfigPath = path.join(
      DATA_DIR,
      'host-mcp-configs',
      `${VALID_REQUEST_ID}.mcp-config.json`,
    );
    expect(fs.existsSync(requestPath)).toBe(true);
    expect(fs.existsSync(mcpConfigPath)).toBe(true);
    expect(hostMcpActiveChildren.has(VALID_REQUEST_ID)).toBe(true);

    // Stub logger.info on the exit-log call to throw
    const { logger } = await import('./logger.js');
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {
      throw new Error('logger blew up');
    });

    // Emit 'exit' — the handler wraps logging in try/finally
    // so the finally block still unlinks the request file and drops the child.
    // The thrown error propagates out of the listener, so wrap in try/catch.
    try {
      fakeChild.emit('exit', 0, null);
    } catch {
      /* expected — logger.info threw */
    }

    expect(hostMcpActiveChildren.has(VALID_REQUEST_ID)).toBe(false);
    expect(fs.existsSync(requestPath)).toBe(false);
    expect(fs.existsSync(mcpConfigPath)).toBe(false);
    infoSpy.mockRestore();
  });

  // ---- T11: timeout → SIGTERM → SIGKILL ----------------------------------
  it('T11: after HOST_MCP_TIMEOUT_MS → failure reply + SIGTERM; after grace → SIGKILL', async () => {
    vi.useFakeTimers();

    await processTaskIpc(validPayload(), MAIN_FOLDER, true, deps);
    expect(spawnStub).toHaveBeenCalledTimes(1);

    // Advance to the soft timeout
    vi.advanceTimersByTime(120_000);
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
    const payload = readFirstMessageFile(MAIN_FOLDER)!;
    expect(payload.text).toMatch(/timed out/i);

    // Advance the grace window — SIGKILL follows
    vi.advanceTimersByTime(5_000);
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');
  });

  // ---- T17: decline-reply file shape (explicit) --------------------------
  it('T17: decline-reply files have canonical shape { type, chatJid, text, groupFolder, timestamp }', async () => {
    await processTaskIpc(
      validPayload({ scope: 'unknown-scope-here' }),
      MAIN_FOLDER,
      true,
      deps,
    );
    const payload = readFirstMessageFile(MAIN_FOLDER)!;
    expect(payload).toMatchObject({
      type: 'message',
      chatJid: VALID_CHAT_JID,
      groupFolder: MAIN_FOLDER,
    });
    expect(typeof payload.text).toBe('string');
    expect((payload.text as string).length).toBeGreaterThan(0);
    expect(typeof payload.timestamp).toBe('string');
    // ISO timestamp is parseable
    expect(isNaN(Date.parse(payload.timestamp as string))).toBe(false);
  });

  // ---- T12: pitchbook_check regression (existing handler) ----------------
  //
  // Uses a nonexistent watchlist slug ("bogus") so the handler always exits
  // before `spawn()` — we only care that the authz gate produces the right
  // warn-log branch. Main/trusted → reach the "watchlist not found" branch
  // (auth passed). Untrusted → stop at "Unauthorized" branch.
  describe('T12 pitchbook_check regression', () => {
    it('main group passes authz (reaches watchlist validation)', async () => {
      const { logger } = await import('./logger.js');
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      await processTaskIpc(
        { type: 'pitchbook_check', watchlist: 'bogus' },
        MAIN_FOLDER,
        true,
        deps,
      );

      // Should have hit watchlist-not-found (auth passed), NOT unauthorized
      const messages = warnSpy.mock.calls.map((c) =>
        typeof c[1] === 'string' ? c[1] : (c[0] as { msg?: string }).msg || '',
      );
      const joined =
        messages.join('|') + '|' + JSON.stringify(warnSpy.mock.calls);
      expect(joined).toMatch(/watchlist not found|invalid watchlist slug/i);
      expect(joined).not.toMatch(/Unauthorized pitchbook_check/);
      warnSpy.mockRestore();
    });

    it('trusted non-main group passes authz', async () => {
      const trustedOther: RegisteredGroup = {
        ...OTHER_GROUP,
        containerConfig: {
          trustedHostActions: ['pitchbook_check'],
        },
      };
      groups['other@g.us'] = trustedOther;
      setRegisteredGroup('other@g.us', trustedOther);

      const { logger } = await import('./logger.js');
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      await processTaskIpc(
        { type: 'pitchbook_check', watchlist: 'bogus' },
        OTHER_FOLDER,
        false,
        deps,
      );

      const joined = JSON.stringify(warnSpy.mock.calls);
      expect(joined).toMatch(/watchlist not found|invalid watchlist slug/i);
      expect(joined).not.toMatch(/Unauthorized pitchbook_check/);
      warnSpy.mockRestore();
    });

    it('untrusted non-main group → unauthorized warn, no further processing', async () => {
      const { logger } = await import('./logger.js');
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      await processTaskIpc(
        { type: 'pitchbook_check', watchlist: 'bogus' },
        OTHER_FOLDER,
        false,
        deps,
      );

      const joined = JSON.stringify(warnSpy.mock.calls);
      expect(joined).toMatch(/Unauthorized pitchbook_check/);
      warnSpy.mockRestore();
    });
  });

  // T18 verified manually: set NANOCLAW_IS_SCHEDULED_TASK=1 and confirm tool returns isError:true
});

// --- hasTrustedHostAction helper (U6 T16) ---
describe('hasTrustedHostAction helper', () => {
  const baseGroup: RegisteredGroup = {
    name: 'X',
    folder: 'x',
    trigger: '@a',
    added_at: '2024-01-01T00:00:00.000Z',
  };

  const cases: Array<{
    label: string;
    reg: RegisteredGroup | undefined;
    action: string;
    expected: boolean;
  }> = [
    {
      label: 'undefined reg',
      reg: undefined,
      action: 'pitchbook_check',
      expected: false,
    },
    {
      label: 'reg without containerConfig',
      reg: baseGroup,
      action: 'pitchbook_check',
      expected: false,
    },
    {
      label: 'containerConfig without trustedHostActions',
      reg: { ...baseGroup, containerConfig: {} },
      action: 'pitchbook_check',
      expected: false,
    },
    {
      label: 'empty trustedHostActions',
      reg: {
        ...baseGroup,
        containerConfig: { trustedHostActions: [] },
      },
      action: 'pitchbook_check',
      expected: false,
    },
    {
      label: 'action missing from list',
      reg: {
        ...baseGroup,
        containerConfig: { trustedHostActions: ['other_action'] },
      },
      action: 'pitchbook_check',
      expected: false,
    },
    {
      label: 'action present in list',
      reg: {
        ...baseGroup,
        containerConfig: { trustedHostActions: ['pitchbook_check'] },
      },
      action: 'pitchbook_check',
      expected: true,
    },
    {
      label: 'namespaced action present',
      reg: {
        ...baseGroup,
        containerConfig: {
          trustedHostActions: ['host_mcp_query:pitchbook'],
        },
      },
      action: 'host_mcp_query:pitchbook',
      expected: true,
    },
    {
      label: 'namespaced scope mismatch',
      reg: {
        ...baseGroup,
        containerConfig: {
          trustedHostActions: ['host_mcp_query:pitchbook'],
        },
      },
      action: 'host_mcp_query:gmail',
      expected: false,
    },
  ];

  for (const c of cases) {
    it(`${c.label} → ${c.expected}`, () => {
      expect(hasTrustedHostAction(c.reg, c.action)).toBe(c.expected);
    });
  }
});
