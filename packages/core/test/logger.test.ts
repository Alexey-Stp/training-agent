import { Writable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { createLogger, LOG_REDACT_CENSOR } from '../src/logger';

const SECRET = 'SENTINEL-ICU-KEY-8f3a2c';

function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger({ LOG_LEVEL: 'trace', NODE_ENV: 'test' }, stream);
  return { logger, output: () => lines.join('') };
}

describe('createLogger redaction', () => {
  it('redacts top-level apiKey', () => {
    const { logger, output } = captureLogger();
    logger.info({ apiKey: SECRET }, 'top-level');
    expect(output()).not.toContain(SECRET);
    expect(output()).toContain(LOG_REDACT_CENSOR);
  });

  it('redacts nested credentials, raw text and args of a job', () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        job: {
          rawText: SECRET,
          args: [SECRET],
          icuCredentials: { athleteId: 'i1', apiKeyCiphertext: SECRET, apiKeyIv: SECRET },
        },
        client: { apiKey: SECRET },
      },
      'nested'
    );
    expect(output()).not.toContain(SECRET);
  });

  it('redacts Telegram message text inside an update', () => {
    const { logger, output } = captureLogger();
    logger.info({ update: { update_id: 1, message: { text: SECRET } } }, 'update');
    expect(output()).not.toContain(SECRET);
    expect(output()).toContain('"update_id":1');
  });

  it('redacts authorization headers', () => {
    const { logger, output } = captureLogger();
    logger.info({ request: { headers: { authorization: `Basic ${SECRET}` } } }, 'req');
    expect(output()).not.toContain(SECRET);
  });

  it('keeps non-sensitive fields', () => {
    const { logger, output } = captureLogger();
    logger.info({ userId: 42, command: 'connect' }, 'ok');
    expect(output()).toContain('"userId":42');
    expect(output()).toContain('"command":"connect"');
  });
});
