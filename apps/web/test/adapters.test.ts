import { describe, expect, it, vi } from 'vitest';
import { PROFILE_RESCHEDULE_JOB } from '@triathlon/core';
import { createChatVerifier, TEST_MESSAGE } from '../src/telegram';
import { createProfileEvents } from '../src/queue';

describe('createChatVerifier', () => {
  it('checks the chat and posts the test message', async () => {
    const api = {
      getChat: vi.fn(() => Promise.resolve({})),
      sendMessage: vi.fn(() => Promise.resolve({})),
    };
    const verifier = createChatVerifier(api as never);
    expect(await verifier.verify('-100123')).toEqual({ ok: true });
    expect(api.getChat).toHaveBeenCalledWith('-100123');
    expect(api.sendMessage).toHaveBeenCalledWith('-100123', TEST_MESSAGE);
  });

  it('turns a failure into a message and sends nothing more', async () => {
    const api = {
      getChat: vi.fn(() => Promise.reject(new Error('network'))),
      sendMessage: vi.fn(),
    };
    const result = await createChatVerifier(api as never).verify('-100123');
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.message).toContain('Telegram is not reachable');
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});

describe('createProfileEvents', () => {
  it('queues one reschedule job for the user', async () => {
    const queue = { add: vi.fn(() => Promise.resolve({})) };
    await createProfileEvents(queue as never).changed('user-a');
    expect(queue.add).toHaveBeenCalledWith(
      PROFILE_RESCHEDULE_JOB,
      { userId: 'user-a' },
      expect.objectContaining({ attempts: 3 })
    );
  });
});
