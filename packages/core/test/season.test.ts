import { describe, it, expect } from 'vitest';
import {
  assertValidSeasonPlan,
  blockEndDate,
  parseSeasonPlan,
  Race,
  RacePriority,
  RaceType,
  SeasonPlan,
  SeasonPlanStatus,
  SeasonValidationError,
  serializeSeasonPlan,
  TrainingBlock,
  TrainingBlockType,
  validateBlockSequence,
  validateSeasonPlan,
} from '../src/season';

const A_RACE: Race = {
  date: '2026-06-14', // Sunday of the race week
  name: 'Challenge Prague',
  priority: RacePriority.A,
  type: RaceType.half,
};

function block(
  order: number,
  type: TrainingBlockType,
  startDate: string,
  weeks: number
): TrainingBlock {
  return {
    order,
    type,
    startDate,
    weeks,
    focus: `${type} focus`,
    targetWeeklyHours: 10,
    targetSwimM: 8000,
    targetBikeH: 5,
    targetRunKm: 30,
    targetCtl: null,
  };
}

/** base 8w → build 6w → peak 3w → taper 2w → race 1w, Mon 2026-01-26 .. Sun 2026-06-14 */
function season(): TrainingBlock[] {
  return [
    block(1, TrainingBlockType.base, '2026-01-26', 8),
    block(2, TrainingBlockType.build, '2026-03-23', 6),
    block(3, TrainingBlockType.peak, '2026-05-04', 3),
    block(4, TrainingBlockType.taper, '2026-05-25', 2),
    block(5, TrainingBlockType.race, '2026-06-08', 1),
  ];
}

function plan(blocks = season(), aRace: Race | null = A_RACE): SeasonPlan {
  return { startDate: '2026-01-26', status: SeasonPlanStatus.draft, aRace, blocks };
}

describe('blockEndDate', () => {
  it('is the last day of the final week', () => {
    expect(blockEndDate({ startDate: '2026-01-26', weeks: 8 })).toBe('2026-03-22');
    expect(blockEndDate({ startDate: '2026-06-08', weeks: 1 })).toBe('2026-06-14');
  });
});

describe('validateBlockSequence: contiguity', () => {
  it('accepts a contiguous season ending on the A-race', () => {
    expect(validateBlockSequence(season(), { aRace: A_RACE })).toEqual([]);
    expect(validateSeasonPlan(plan())).toEqual([]);
  });

  it('reports a gap naming both blocks', () => {
    const blocks = season();
    blocks[1] = { ...blocks[1], weeks: 5 }; // build ends a week early

    const issues = validateBlockSequence(blocks);
    expect(issues).toEqual([
      {
        code: 'gap',
        message: 'block 2 (build) ends 2026-04-26 but block 3 (peak) starts 2026-05-04: 7-day gap',
        blockOrders: [2, 3],
      },
    ]);
  });

  it('reports an overlap naming both blocks', () => {
    const blocks = season();
    blocks[2] = { ...blocks[2], startDate: '2026-05-01' }; // peak starts before build ends

    const issues = validateBlockSequence(blocks);
    expect(issues.map((i) => [i.code, i.blockOrders])).toEqual([
      ['overlap', [2, 3]],
      ['gap', [3, 4]],
    ]);
    expect(issues[0].message).toContain('3-day overlap');
  });

  it('validates blocks in order, not array position', () => {
    expect(validateBlockSequence([...season()].reverse(), { aRace: A_RACE })).toEqual([]);
  });
});

describe('validateBlockSequence: block shape', () => {
  it('rejects non-positive or fractional weeks and bad dates', () => {
    const blocks = [
      block(1, TrainingBlockType.base, '2026-01-26', 0),
      block(2, TrainingBlockType.build, '2026-02-30', 4),
      block(3, TrainingBlockType.peak, '2026-03-02', 1.5),
    ];
    const issues = validateBlockSequence(blocks);
    expect(issues.map((i) => [i.code, i.blockOrders])).toEqual([
      ['invalid_block', [1]],
      ['invalid_block', [2]],
      ['invalid_block', [3]],
    ]);
  });

  it('rejects duplicate order', () => {
    const blocks = [
      block(1, TrainingBlockType.base, '2026-01-26', 4),
      block(1, TrainingBlockType.build, '2026-02-23', 4),
    ];
    expect(validateBlockSequence(blocks).map((i) => i.code)).toEqual(['duplicate_order']);
  });
});

describe('validateBlockSequence: taper before A-race', () => {
  it('requires the block before the race block to be a taper', () => {
    const blocks = season();
    blocks[3] = { ...blocks[3], type: TrainingBlockType.peak };

    const issues = validateBlockSequence(blocks, { aRace: A_RACE });
    expect(issues).toEqual([
      {
        code: 'taper_missing',
        message: 'block 5 (race) must be preceded by a taper block, not block 4 (peak)',
        blockOrders: [4, 5],
      },
    ]);
  });

  it('requires a taper even when the race block is first', () => {
    const blocks = [block(1, TrainingBlockType.race, '2026-06-08', 1)];
    const issues = validateBlockSequence(blocks, { aRace: A_RACE });
    expect(issues.map((i) => [i.code, i.blockOrders])).toEqual([['taper_missing', [1]]]);
  });

  it('requires the block containing the race date to be a race block', () => {
    const blocks = season().slice(0, 4);
    blocks.push(block(5, TrainingBlockType.build, '2026-06-08', 1));

    const issues = validateBlockSequence(blocks, { aRace: A_RACE });
    expect(issues.map((i) => [i.code, i.blockOrders])).toEqual([['race_block_wrong_type', [5]]]);
    expect(issues[0].message).toContain('Challenge Prague');
  });

  it('requires the race block to end on race week', () => {
    const blocks = season();
    blocks[4] = { ...blocks[4], weeks: 2 }; // race block runs a week past the race

    const issues = validateBlockSequence(blocks, { aRace: A_RACE });
    expect(issues.map((i) => [i.code, i.blockOrders])).toEqual([['race_not_in_final_week', [5]]]);
  });

  it('reports a season that ends before the A-race', () => {
    const issues = validateBlockSequence(season().slice(0, 4), { aRace: A_RACE });
    expect(issues.map((i) => [i.code, i.blockOrders])).toEqual([['race_block_missing', [4]]]);
  });

  it('allows blocks after the race week (e.g. recovery)', () => {
    const blocks = [...season(), block(6, TrainingBlockType.recovery, '2026-06-15', 2)];
    expect(validateBlockSequence(blocks, { aRace: A_RACE })).toEqual([]);
  });

  it('ignores B/C races and plans without an A-race', () => {
    const blocks = season().slice(0, 3);
    expect(
      validateBlockSequence(blocks, { aRace: { ...A_RACE, priority: RacePriority.B } })
    ).toEqual([]);
    expect(validateBlockSequence(blocks, { aRace: null })).toEqual([]);
  });
});

describe('validateSeasonPlan / assertValidSeasonPlan', () => {
  it('requires the first block to start on the plan start date', () => {
    const issues = validateSeasonPlan({ ...plan(), startDate: '2026-01-19' });
    expect(issues.map((i) => [i.code, i.blockOrders])).toEqual([['plan_start_mismatch', [1]]]);
  });

  it('throws a SeasonValidationError naming the offending blocks', () => {
    const blocks = season();
    blocks[1] = { ...blocks[1], weeks: 5 };

    let caught: unknown;
    try {
      assertValidSeasonPlan(plan(blocks));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SeasonValidationError);
    const err = caught as SeasonValidationError;
    expect(err.message).toContain('block 2 (build)');
    expect(err.message).toContain('block 3 (peak)');
    expect(err.issues.map((i) => i.code)).toEqual(['gap']);
  });

  it('does not throw for a valid plan', () => {
    expect(() => {
      assertValidSeasonPlan(plan());
    }).not.toThrow();
  });
});

describe('season plan serialization', () => {
  it('round-trips through JSON', () => {
    const blocks = season();
    blocks[2] = { ...blocks[2], targetCtl: 82.5 };
    const original = plan(blocks);

    const parsed = parseSeasonPlan(serializeSeasonPlan(original));
    expect(parsed).toEqual(original);
    expect(validateSeasonPlan(parsed)).toEqual([]);
  });

  it('round-trips a plan without an A-race', () => {
    const original = plan(season(), null);
    expect(parseSeasonPlan(serializeSeasonPlan(original))).toEqual(original);
  });

  it('rejects unknown enum values and malformed dates', () => {
    const json = JSON.parse(serializeSeasonPlan(plan())) as {
      blocks: { type: string; startDate: string }[];
      aRace: { priority: string };
    };

    expect(() =>
      parseSeasonPlan(JSON.stringify({ ...json, aRace: { ...json.aRace, priority: 'D' } }))
    ).toThrow();
    expect(() =>
      parseSeasonPlan(
        JSON.stringify({ ...json, blocks: [{ ...json.blocks[0], type: 'off-season' }] })
      )
    ).toThrow();
    expect(() =>
      parseSeasonPlan(
        JSON.stringify({ ...json, blocks: [{ ...json.blocks[0], startDate: '26-1-1' }] })
      )
    ).toThrow();
  });
});
