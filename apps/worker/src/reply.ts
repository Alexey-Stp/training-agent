/** An inline keyboard button: label and callback data. */
export interface InlineButton {
  text: string;
  data: string;
}

/** A reply with HTML formatting and/or inline buttons. Plain replies stay plain strings. */
export interface RichReply {
  text: string;
  /** Telegram HTML parse mode: escape dynamic text with core `escapeHtml` */
  html?: boolean;
  keyboard?: InlineButton[][];
}

export type Reply = string | RichReply;

/** sendMessage `other` options for a reply (assignable to grammY's). */
export interface TelegramMessageOptions {
  parse_mode?: 'HTML';
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
}

export function toTelegramMessage(reply: Reply): { text: string; options: TelegramMessageOptions } {
  if (typeof reply === 'string') return { text: reply, options: {} };
  const options: TelegramMessageOptions = {};
  if (reply.html) options.parse_mode = 'HTML';
  if (reply.keyboard) {
    options.reply_markup = {
      inline_keyboard: reply.keyboard.map((row) =>
        row.map((b) => ({ text: b.text, callback_data: b.data }))
      ),
    };
  }
  return { text: reply.text, options };
}
