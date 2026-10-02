import { describe, it, expect } from 'vitest';
import { seasonDecisionData } from '@triathlon/core';
import { routeSeasonDecision } from '../src/season-callbacks';

const DRAFT = 'cmg1x2y3z0000abcd1234efgh';

describe('routeSeasonDecision', () => {
  it('save confirms without acknowledging a replacement', () => {
    expect(routeSeasonDecision(seasonDecisionData('save', DRAFT))).toMatchObject({
      commandName: 'season_confirm',
      args: [DRAFT],
    });
  });

  it('replace confirms with the replacement acknowledged', () => {
    expect(routeSeasonDecision(seasonDecisionData('replace', DRAFT))).toMatchObject({
      commandName: 'season_confirm',
      args: [DRAFT, 'replace'],
    });
  });

  it('cancel discards the draft', () => {
    expect(routeSeasonDecision(seasonDecisionData('cancel', DRAFT))).toMatchObject({
      commandName: 'season_cancel',
      args: [DRAFT],
    });
  });

  it('ignores wizard buttons and malformed data', () => {
    for (const data of ['sn:h:10', 'sd:save', 'sd:nuke:abc', 'sd:save:a b', '']) {
      expect(routeSeasonDecision(data)).toBeNull();
    }
  });
});
