import { describe, expect, it } from 'vitest';
import { BLOCK_CONFIRM_COMMAND, BLOCK_DECLINE_COMMAND, blockReviewData } from '@triathlon/core';
import { routeBlockReview } from '../src/block-callbacks';

describe('routeBlockReview', () => {
  it('maps Confirm and Decline to their commands with the run id', () => {
    expect(routeBlockReview(blockReviewData('confirm', 'run1'))).toEqual({
      commandName: BLOCK_CONFIRM_COMMAND,
      args: ['run1'],
      toast: 'Re-projecting your season…',
    });
    expect(routeBlockReview(blockReviewData('decline', 'run1'))?.commandName).toBe(
      BLOCK_DECLINE_COMMAND
    );
  });

  it('ignores other callback data', () => {
    expect(routeBlockReview('cc:a:d1')).toBeNull();
    expect(routeBlockReview('sd:save:d1')).toBeNull();
  });
});
