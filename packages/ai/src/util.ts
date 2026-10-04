import { createHash } from 'node:crypto';

/** `Name: message` of a caught error, for audit reasons */
export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name + ': ' + error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
