import { RaceType } from '../season/types';

export interface ChecklistSection {
  title: string;
  items: string[];
}

const SWIM_GEAR = ['Wetsuit (if legal) and goggles + spare pair', 'Swim cap and anti-chafe'];
const BIKE_GEAR = [
  'Bike serviced, tyres checked, spare tube and CO2',
  'Helmet, bike shoes, race belt',
];
const RUN_GEAR = ['Run shoes (broken in)', 'Hat or visor, sunglasses'];

const TYPE_GEAR: Record<RaceType, string[]> = {
  [RaceType.sprint]: [...SWIM_GEAR, ...BIKE_GEAR, ...RUN_GEAR],
  [RaceType.olympic]: [...SWIM_GEAR, ...BIKE_GEAR, ...RUN_GEAR, 'Bottle(s) on the bike'],
  [RaceType.half]: [
    ...SWIM_GEAR,
    ...BIKE_GEAR,
    ...RUN_GEAR,
    'Bottles and gels on the bike, spare nutrition',
    'Transition bags labelled',
  ],
  [RaceType.full]: [
    ...SWIM_GEAR,
    ...BIKE_GEAR,
    ...RUN_GEAR,
    'Bike and run special-needs bags',
    'Bottles, gels and salt on the bike',
    'Transition bags labelled, change of clothes',
  ],
  [RaceType.run]: [...RUN_GEAR, 'Race kit laid out', 'Gels or chews for the course'],
  [RaceType.other]: ['Kit for every discipline laid out', 'Spare nutrition'],
};

export function raceChecklist(raceType: RaceType): ChecklistSection[] {
  return [
    { title: 'Gear', items: TYPE_GEAR[raceType] },
    {
      title: 'Nutrition',
      items: [
        'Review your race-day nutrition plan',
        'Nothing new on race day: use what you trained with',
      ],
    },
    {
      title: 'Admin',
      items: [
        'Confirm registration and collect your race pack',
        'Check the briefing time and start wave',
      ],
    },
  ];
}
