// Mirror the Prisma enums of the same names (prisma/schema.prisma)

export enum RacePriority {
  A = 'A',
  B = 'B',
  C = 'C',
}

export enum RaceType {
  sprint = 'sprint',
  olympic = 'olympic',
  half = 'half',
  full = 'full',
  run = 'run',
  other = 'other',
}

export enum SeasonPlanStatus {
  draft = 'draft',
  active = 'active',
  completed = 'completed',
  archived = 'archived',
}

export enum TrainingBlockType {
  base = 'base',
  build = 'build',
  peak = 'peak',
  taper = 'taper',
  race = 'race',
  recovery = 'recovery',
  transition = 'transition',
}

export interface Race {
  date: string; // YYYY-MM-DD
  name: string;
  priority: RacePriority;
  type: RaceType;
  /** Travel day before the race (yyyy-MM-dd); within T-3..T-1 it becomes a rest day */
  travelDate?: string | null;
}

export interface TrainingBlock {
  /** 1-based position in the season. Validation errors name blocks by it. */
  order: number;
  type: TrainingBlockType;
  startDate: string; // YYYY-MM-DD
  weeks: number;
  focus: string;
  targetWeeklyHours: number;
  targetSwimM: number; // per week
  targetBikeH: number; // per week
  targetRunKm: number; // per week
  targetCtl: number | null; // fitness at block end
}

export interface SeasonPlan {
  startDate: string; // YYYY-MM-DD
  status: SeasonPlanStatus;
  aRace: Race | null;
  blocks: TrainingBlock[];
}
