import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';
import { parseTextStyles, ChannelType } from './text-styles.js';

export type ContentBlock = {
  type: string;
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
  [key: string]: unknown;
};

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

/**
 * Build multimodal content blocks when messages contain images.
 * Returns the XML text block followed by image blocks.
 */
export function formatMessagesMultimodal(
  messages: NewMessage[],
  timezone: string,
): ContentBlock[] {
  const blocks: ContentBlock[] = [
    { type: 'text', text: formatMessages(messages, timezone) },
  ];

  for (const msg of messages) {
    if (!msg.images?.length) continue;
    for (const img of msg.images) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType,
          data: img.data,
        },
      });
    }
  }

  return blocks;
}

/** Returns true if any message in the batch contains images. */
export function hasImages(messages: NewMessage[]): boolean {
  return messages.some((m) => m.images && m.images.length > 0);
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string, channel?: ChannelType): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return channel ? parseTextStyles(text, channel) : text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
