import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';
import sharp from 'sharp';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { saveAttachment } from './attachment-store.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  MessageImage,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// Max image size to download (5 MB). Larger files are skipped to avoid
// bloating the prompt context sent to Claude.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// MIME types we'll process as images
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined), bot messages
// (BotMessageEvent, subtype 'bot_message'), and file_share messages so we can handle images.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
}

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private botToken: string;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.botToken = botToken;

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();

    // Catch-all: log any event type we're not explicitly handling
    // to discover how Slack delivers file uploads
    this.app.use(async ({ body, next }) => {
      const b = body as {
        event?: { type?: string; subtype?: string; files?: unknown[] };
      };
      if (
        b.event &&
        (b.event.files || (b.event.type && b.event.type !== 'message'))
      ) {
        logger.info(
          {
            eventType: b.event.type,
            subtype: b.event.subtype,
            hasFiles: !!b.event.files,
            fileCount: b.event.files?.length,
            keys: Object.keys(b.event),
          },
          'Slack non-message event with files',
        );
      }
      await next();
    });
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      const subtype = (event as { subtype?: string }).subtype;
      const files = (event as { files?: SlackFile[] }).files;

      // Temporary: log every incoming message event shape
      logger.info(
        {
          subtype: subtype || '(none)',
          hasFiles: !!files,
          fileCount: files?.length,
          hasText: !!(event as { text?: string }).text,
          channel: (event as { channel?: string }).channel,
          keys: Object.keys(event),
        },
        'Slack message event received',
      );

      if (subtype && subtype !== 'bot_message' && subtype !== 'file_share')
        return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;
      const hasImages = files?.some(
        (f) => f.mimetype && IMAGE_MIME_TYPES.has(f.mimetype),
      );
      const hasOtherFiles = files?.some(
        (f) => f.mimetype && !IMAGE_MIME_TYPES.has(f.mimetype),
      );

      // Allow through if there's text, images, or other attachments
      if (!msg.text && !hasImages && !hasOtherFiles) return;

      // Threaded replies are flattened into the channel conversation.
      // The agent sees them alongside channel-level messages; responses
      // always go to the channel, not back into the thread.

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text || '';
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Download images from file_share messages
      let images: MessageImage[] | undefined;
      if (hasImages && !isBotMessage) {
        images = await this.downloadImages(files!);
        if (images.length > 0 && !content) {
          content = '[image]';
        }
      }

      // Download non-image attachments (PDFs, text, CSVs, etc.) to the
      // group's incoming/ folder. The agent reads them via pdftotext / Read.
      if (hasOtherFiles && !isBotMessage && files) {
        const refs = await this.downloadOtherAttachments(
          files,
          groups[jid].folder,
        );
        if (refs.length > 0) {
          const attachLines = refs
            .map((r) => `[Attached file: ${r}]`)
            .join('\n');
          content = content ? `${content}\n${attachLines}` : attachLines;
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
        images,
      });
    });
  }

  private async downloadImages(files: SlackFile[]): Promise<MessageImage[]> {
    const images: MessageImage[] = [];
    for (const file of files) {
      if (!file.mimetype || !IMAGE_MIME_TYPES.has(file.mimetype)) continue;
      if (!file.url_private) continue;
      if (file.size && file.size > MAX_IMAGE_BYTES) {
        logger.warn(
          { fileName: file.name, size: file.size },
          'Skipping oversized image',
        );
        continue;
      }

      try {
        const resp = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${this.botToken}` },
        });
        if (!resp.ok) {
          logger.warn(
            { fileName: file.name, status: resp.status },
            'Failed to download Slack image',
          );
          continue;
        }
        // Slack returns 200 OK with an HTML sign-in page when the bot token
        // lacks `files:read` scope. Without this guard, that HTML gets sent
        // to the model as "image/jpeg" and the API rejects the whole request.
        const contentType = resp.headers.get('content-type') || '';
        if (!contentType.startsWith('image/')) {
          logger.warn(
            { fileName: file.name, contentType, status: resp.status },
            'Slack image download returned non-image content (check bot has files:read scope)',
          );
          continue;
        }
        const buffer = Buffer.from(await resp.arrayBuffer());
        if (buffer.length > MAX_IMAGE_BYTES) continue;
        // Resize to stay under Claude's 3.75 megapixel recommendation while
        // preserving aspect ratio. Animated GIFs are passed through as-is.
        const isAnimated = file.mimetype === 'image/gif';
        const processed = isAnimated
          ? buffer
          : await sharp(buffer)
              .resize({
                width: 1568,
                height: 1568,
                fit: 'inside',
                withoutEnlargement: true,
              })
              .jpeg({ quality: 85 })
              .toBuffer();
        const mediaType = isAnimated ? file.mimetype : 'image/jpeg';
        images.push({
          mediaType,
          data: processed.toString('base64'),
        });
        logger.debug(
          {
            fileName: file.name,
            origSize: buffer.length,
            outSize: processed.length,
          },
          'Downloaded Slack image',
        );
      } catch (err) {
        logger.warn(
          { fileName: file.name, err },
          'Error downloading Slack image',
        );
      }
    }
    return images;
  }

  private async downloadOtherAttachments(
    files: SlackFile[],
    groupFolder: string,
  ): Promise<string[]> {
    const refs: string[] = [];
    for (const file of files) {
      if (!file.mimetype || IMAGE_MIME_TYPES.has(file.mimetype)) continue;
      if (!file.url_private) continue;
      try {
        const resp = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${this.botToken}` },
        });
        if (!resp.ok) {
          logger.warn(
            { fileName: file.name, status: resp.status },
            'Failed to download Slack attachment',
          );
          continue;
        }
        // Same sign-in-HTML trap as images: verify Slack actually returned
        // the file content rather than an auth redirect.
        const contentType = resp.headers.get('content-type') || '';
        if (contentType.startsWith('text/html')) {
          logger.warn(
            { fileName: file.name, contentType },
            'Slack attachment download returned HTML (likely missing files:read scope)',
          );
          continue;
        }
        const buffer = Buffer.from(await resp.arrayBuffer());
        const saved = await saveAttachment(
          groupFolder,
          file.name || 'attachment',
          buffer,
        );
        if (saved) {
          logger.info(
            {
              fileName: file.name,
              path: saved.relativePath,
              bytes: saved.bytes,
            },
            'Stored Slack attachment',
          );
          refs.push(saved.relativePath);
        }
      } catch (err) {
        logger.warn(
          { fileName: file.name, err },
          'Error downloading Slack attachment',
        );
      }
    }
    return refs;
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({ channel: channelId, text });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
