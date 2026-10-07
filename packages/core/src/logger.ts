import pino from 'pino';
import type { EnvConfig } from './config';

/**
 * Log paths that may carry credentials or raw user input (e.g. an ICU API key
 * typed into the /connect dialog). Censored in every app logger.
 */
export const LOG_REDACT_PATHS = [
  'apiKey',
  '*.apiKey',
  'apiKeyCiphertext',
  '*.apiKeyCiphertext',
  'apiKeyIv',
  '*.apiKeyIv',
  'icuCredentials',
  '*.icuCredentials',
  'rawText',
  '*.rawText',
  'args',
  '*.args',
  'text',
  'message.text',
  '*.message.text',
  'headers.authorization',
  '*.headers.authorization',
  // Dashboard magic-link tokens and session cookies (TA-52)
  'token',
  '*.token',
  'cookie',
  '*.cookie',
  'headers.cookie',
  '*.headers.cookie',
  'query.t',
  '*.query.t',
];

export const LOG_REDACT_CENSOR = '[REDACTED]';

export function createLogger(
  config: Pick<EnvConfig, 'LOG_LEVEL' | 'NODE_ENV'>,
  destination?: pino.DestinationStream
): pino.Logger {
  const options: pino.LoggerOptions = {
    level: config.LOG_LEVEL,
    redact: { paths: LOG_REDACT_PATHS, censor: LOG_REDACT_CENSOR },
  };

  if (destination) {
    return pino(options, destination);
  }

  if (config.NODE_ENV === 'development') {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        ignore: 'pid,hostname',
        translateTime: 'SYS:standard',
      },
    };
  }

  return pino(options);
}
