/** An inline keyboard button: label and callback data. */
export interface InlineButton {
  text: string;
  data: string;
}

/** An inline keyboard button that opens a URL (e.g. the dashboard magic link). */
export interface UrlButton {
  text: string;
  url: string;
}

/** A reply with HTML formatting and/or inline buttons. Plain replies stay plain strings. */
export interface RichReply {
  text: string;
  /** Telegram HTML parse mode: escape dynamic text with core `escapeHtml` */
  html?: boolean;
  keyboard?: InlineButton[][];
  /** URL buttons, one per row, below the keyboard */
  links?: UrlButton[];
  /** Replace the message whose button was tapped (`CommandJob.messageId`) instead of sending */
  editTapped?: boolean;
}

export type Reply = string | RichReply;

type TelegramButton = { text: string; callback_data: string } | { text: string; url: string };

/** sendMessage `other` options for a reply (assignable to grammY's). */
export interface TelegramMessageOptions {
  parse_mode?: 'HTML';
  reply_markup?: { inline_keyboard: TelegramButton[][] };
}

export function toTelegramMessage(reply: Reply): { text: string; options: TelegramMessageOptions } {
  if (typeof reply === 'string') return { text: reply, options: {} };
  const options: TelegramMessageOptions = {};
  if (reply.html) options.parse_mode = 'HTML';
  const rows: TelegramButton[][] = [
    ...(reply.keyboard ?? []).map((row) =>
      row.map((b) => ({ text: b.text, callback_data: b.data }))
    ),
    ...(reply.links ?? []).map((link) => [{ text: link.text, url: link.url }]),
  ];
  if (rows.length > 0) options.reply_markup = { inline_keyboard: rows };
  return { text: reply.text, options };
}
