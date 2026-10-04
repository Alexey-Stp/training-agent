import { describe, it, expect } from 'vitest';
import { parseCommand } from '../src/parser';

describe('parseCommand', () => {
  it('parses a slash command with lowercased name and args', () => {
    expect(parseCommand('/Plan push')).toEqual({ commandName: 'plan', args: ['push'] });
  });

  it('routes plain text to the coach chat', () => {
    expect(parseCommand('  can I move the long ride to Saturday?  ')).toEqual({
      commandName: 'coach_chat',
      args: [],
    });
  });

  it('keeps an unknown slash command a command', () => {
    expect(parseCommand('/dance')).toEqual({ commandName: 'dance', args: [] });
  });
});
