import { describe, it, expect } from 'vitest';
import { applyRules } from '../src/rules-engine';
import { WeekPlan, Session, Sport, Intensity, RulesContext } from '../src/types';

describe('Rules Engine', () => {
  describe('SwimRotation Rule', () => {
    it('should enforce Wed as technique and Fri as intervals', () => {
      const plan: WeekPlan = {
        startDate: '2026-02-10', // Monday
        sessions: [
          {
            date: '2026-02-12', // Wed
            sport: Sport.swim,
            title: 'Swim Workout',
            durationMin: 50,
            intensity: Intensity.z4,
            tags: ['intervals'], // Wrong - should be technique
          },
          {
            date: '2026-02-14', // Fri
            sport: Sport.swim,
            title: 'Swim Technique',
            durationMin: 50,
            intensity: Intensity.z2,
            tags: ['technique'], // Wrong - should be intervals
          },
        ],
        warnings: [],
        appliedRules: [],
      };

      const context: RulesContext = {
        last7dStats: { totalMinutes: 0, byDate: [] },
      };

      const result = applyRules(plan, context);

      const wedSession = result.sessions.find(s => s.date === '2026-02-12');
      const friSession = result.sessions.find(s => s.date === '2026-02-14');

      expect(wedSession?.tags).toContain('technique');
      expect(wedSession?.title).toContain('Technique');

      expect(friSession?.tags).toContain('intervals');
      expect(friSession?.intensity).toBe(Intensity.z4);

      expect(result.appliedRules).toContain(
        'SwimRotation: Adjusted swim sessions to match Wed=technique, Fri=intervals'
      );
    });
  });

  describe('ReadinessDownshift Rule', () => {
    it('should downgrade hard sessions when readiness <= 2', () => {
      const plan: WeekPlan = {
        startDate: '2026-02-10',
        sessions: [
          {
            date: '2026-02-10', // Today
            sport: Sport.bike,
            title: 'Bike VO2 Max',
            durationMin: 70,
            intensity: Intensity.z5,
            tags: ['vo2'],
          },
          {
            date: '2026-02-11', // Tomorrow - should NOT be downgraded (not same day)
            sport: Sport.run,
            title: 'Run Intervals',
            durationMin: 55,
            intensity: Intensity.z4,
          },
        ],
        warnings: [],
        appliedRules: [],
      };

      const context: RulesContext = {
        last7dStats: { totalMinutes: 300, byDate: [] },
        todayFatigue: {
          readiness: 2,
        },
      };

      const result = applyRules(plan, context);

      const todaySession = result.sessions.find(s => s.date === '2026-02-10');
      const tomorrowSession = result.sessions.find(s => s.date === '2026-02-11');

      expect(todaySession?.intensity).toBe(Intensity.z2);
      expect(todaySession?.title).toContain('downgraded');
      expect(tomorrowSession?.intensity).toBe(Intensity.z4); // Should remain hard

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('Low readiness');
    });

    it('should not downgrade when readiness > 2', () => {
      const plan: WeekPlan = {
        startDate: '2026-02-10',
        sessions: [
          {
            date: '2026-02-10',
            sport: Sport.bike,
            title: 'Bike VO2 Max',
            durationMin: 70,
            intensity: Intensity.z5,
            tags: ['vo2'],
          },
        ],
        warnings: [],
        appliedRules: [],
      };

      const context: RulesContext = {
        last7dStats: { totalMinutes: 300, byDate: [] },
        todayFatigue: {
          readiness: 4,
        },
      };

      const result = applyRules(plan, context);

      const todaySession = result.sessions[0];
      expect(todaySession.intensity).toBe(Intensity.z5);
      expect(todaySession.title).not.toContain('downgraded');
    });
  });

  describe('NoHardHard Rule', () => {
    it('should prevent back-to-back hard sessions', () => {
      const plan: WeekPlan = {
        startDate: '2026-02-10',
        sessions: [
          {
            date: '2026-02-10', // Mon - Hard
            sport: Sport.bike,
            title: 'Bike VO2',
            durationMin: 70,
            intensity: Intensity.z5,
            tags: ['vo2'],
          },
          {
            date: '2026-02-11', // Tue - Hard (consecutive!)
            sport: Sport.run,
            title: 'Run Intervals',
            durationMin: 55,
            intensity: Intensity.z4,
          },
          {
            date: '2026-02-12', // Wed - Easy
            sport: Sport.swim,
            title: 'Swim Technique',
            durationMin: 50,
            intensity: Intensity.z2,
          },
        ],
        warnings: [],
        appliedRules: [],
      };

      const context: RulesContext = {
        last7dStats: { totalMinutes: 300, byDate: [] },
      };

      const result = applyRules(plan, context);

      const monSession = result.sessions.find(s => s.date === '2026-02-10');
      const tueSession = result.sessions.find(s => s.date === '2026-02-11');

      expect(monSession?.intensity).toBe(Intensity.z5); // First hard session remains
      expect(tueSession?.intensity).toBe(Intensity.z2); // Second downgraded
      expect(tueSession?.title).toContain('downgraded');

      expect(result.warnings.some(w => w.includes('back-to-back'))).toBe(true);
    });

    it('should allow hard sessions with easy day in between', () => {
      const plan: WeekPlan = {
        startDate: '2026-02-10',
        sessions: [
          {
            date: '2026-02-10', // Mon - Hard
            sport: Sport.bike,
            title: 'Bike VO2',
            durationMin: 70,
            intensity: Intensity.z5,
            tags: ['vo2'],
          },
          {
            date: '2026-02-11', // Tue - Easy
            sport: Sport.swim,
            title: 'Swim Technique',
            durationMin: 50,
            intensity: Intensity.z2,
          },
          {
            date: '2026-02-12', // Wed - Hard (NOT consecutive with Mon)
            sport: Sport.run,
            title: 'Run Intervals',
            durationMin: 55,
            intensity: Intensity.z4,
          },
        ],
        warnings: [],
        appliedRules: [],
      };

      const context: RulesContext = {
        last7dStats: { totalMinutes: 300, byDate: [] },
      };

      const result = applyRules(plan, context);

      const monSession = result.sessions.find(s => s.date === '2026-02-10');
      const wedSession = result.sessions.find(s => s.date === '2026-02-12');

      expect(monSession?.intensity).toBe(Intensity.z5);
      expect(wedSession?.intensity).toBe(Intensity.z4);
      expect(result.warnings.some(w => w.includes('back-to-back'))).toBe(false);
    });

    it('should handle multiple consecutive hard sessions', () => {
      const plan: WeekPlan = {
        startDate: '2026-02-10',
        sessions: [
          {
            date: '2026-02-10', // Mon - Hard
            sport: Sport.run,
            title: 'Run Hard',
            durationMin: 60,
            intensity: Intensity.z4,
          },
          {
            date: '2026-02-11', // Tue - Hard (consecutive!)
            sport: Sport.bike,
            title: 'Bike Hard',
            durationMin: 60,
            intensity: Intensity.z5,
          },
          {
            date: '2026-02-12', // Wed - Hard (would be consecutive with Tue if not downgraded)
            sport: Sport.run,
            title: 'Run Hard',
            durationMin: 55,
            intensity: Intensity.z4,
          },
        ],
        warnings: [],
        appliedRules: [],
      };

      const context: RulesContext = {
        last7dStats: { totalMinutes: 300, byDate: [] },
      };

      const result = applyRules(plan, context);

      const monSession = result.sessions.find(s => s.date === '2026-02-10');
      const tueSession = result.sessions.find(s => s.date === '2026-02-11');
      const wedSession = result.sessions.find(s => s.date === '2026-02-12');

      expect(monSession?.intensity).toBe(Intensity.z4); // Stays hard
      expect(tueSession?.intensity).toBe(Intensity.z2); // Downgraded
      expect(wedSession?.intensity).toBe(Intensity.z4); // Can stay hard since Tue was downgraded
    });
  });

  describe('WeeklyLoadCap Rule', () => {
    it('should cap weekly load at 110% of last week', () => {
      const plan: WeekPlan = {
        startDate: '2026-02-10',
        sessions: [
          {
            date: '2026-02-10',
            sport: Sport.bike,
            title: 'Bike',
            durationMin: 100,
            intensity: Intensity.z2,
          },
          {
            date: '2026-02-11',
            sport: Sport.run,
            title: 'Run',
            durationMin: 100,
            intensity: Intensity.z4,
          },
          {
            date: '2026-02-12',
            sport: Sport.swim,
            title: 'Swim',
            durationMin: 100,
            intensity: Intensity.z2,
          },
        ],
        warnings: [],
        appliedRules: [],
      };

      const context: RulesContext = {
        last7dStats: {
          totalMinutes: 200, // Last week was 200min
          byDate: [],
        },
      };

      const result = applyRules(plan, context);

      const totalPlannedMinutes = result.sessions.reduce((sum, s) => sum + s.durationMin, 0);
      const maxAllowed = 200 * 1.1; // 220 minutes

      expect(totalPlannedMinutes).toBeLessThanOrEqual(maxAllowed);
      expect(result.warnings.some(w => w.includes('Weekly load capped'))).toBe(true);
      expect(result.appliedRules.some(r => r.includes('WeeklyLoadCap'))).toBe(true);
    });

    it('should not scale down if within 110% limit', () => {
      const plan: WeekPlan = {
        startDate: '2026-02-10',
        sessions: [
          {
            date: '2026-02-10',
            sport: Sport.bike,
            title: 'Bike',
            durationMin: 50,
            intensity: Intensity.z2,
          },
          {
            date: '2026-02-11',
            sport: Sport.run,
            title: 'Run',
            durationMin: 50,
            intensity: Intensity.z2,
          },
        ],
        warnings: [],
        appliedRules: [],
      };

      const context: RulesContext = {
        last7dStats: {
          totalMinutes: 200, // Last week was 200min, this week is 100min
          byDate: [],
        },
      };

      const result = applyRules(plan, context);

      expect(result.sessions[0].durationMin).toBe(50);
      expect(result.sessions[1].durationMin).toBe(50);
      expect(result.warnings.some(w => w.includes('Weekly load capped'))).toBe(false);
    });

    it('should skip load cap if no previous week data', () => {
      const plan: WeekPlan = {
        startDate: '2026-02-10',
        sessions: [
          {
            date: '2026-02-10',
            sport: Sport.bike,
            title: 'Bike',
            durationMin: 500,
            intensity: Intensity.z2,
          },
        ],
        warnings: [],
        appliedRules: [],
      };

      const context: RulesContext = {
        last7dStats: {
          totalMinutes: 0, // No history
          byDate: [],
        },
      };

      const result = applyRules(plan, context);

      expect(result.sessions[0].durationMin).toBe(500); // Unchanged
      expect(result.warnings.some(w => w.includes('Weekly load capped'))).toBe(false);
    });

    it('should maintain minimum 30 minutes per session', () => {
      const plan: WeekPlan = {
        startDate: '2026-02-10',
        sessions: [
          {
            date: '2026-02-10',
            sport: Sport.bike,
            title: 'Bike',
            durationMin: 40,
            intensity: Intensity.z2,
          },
          {
            date: '2026-02-11',
            sport: Sport.run,
            title: 'Run',
            durationMin: 960, // 16 hours (unrealistic but tests the cap)
            intensity: Intensity.z2,
          },
        ],
        warnings: [],
        appliedRules: [],
      };

      const context: RulesContext = {
        last7dStats: {
          totalMinutes: 50, // Very low last week
          byDate: [],
        },
      };

      const result = applyRules(plan, context);

      // All sessions should be at least 30 minutes
      result.sessions.forEach(session => {
        if (session.sport !== Sport.rest) {
          expect(session.durationMin).toBeGreaterThanOrEqual(30);
        }
      });
    });
  });

  describe('Combined Rules Interactions', () => {
    it('should apply multiple rules correctly', () => {
      const plan: WeekPlan = {
        startDate: '2026-02-10',
        sessions: [
          {
            date: '2026-02-10', // Mon - Hard
            sport: Sport.bike,
            title: 'Bike VO2',
            durationMin: 200,
            intensity: Intensity.z5,
            tags: ['vo2'],
          },
          {
            date: '2026-02-11', // Tue - Hard (will be downgraded by NoHardHard)
            sport: Sport.run,
            title: 'Run Intervals',
            durationMin: 200,
            intensity: Intensity.z4,
          },
          {
            date: '2026-02-12', // Wed - Swim
            sport: Sport.swim,
            title: 'Swim',
            durationMin: 200,
            intensity: Intensity.z4,
            tags: ['intervals'], // Wrong - should be technique (SwimRotation)
          },
        ],
        warnings: [],
        appliedRules: [],
      };

      const context: RulesContext = {
        last7dStats: {
          totalMinutes: 200, // Will trigger load cap (600 > 220)
          byDate: [],
        },
      };

      const result = applyRules(plan, context);

      // Check SwimRotation was applied
      const wedSession = result.sessions.find(s => s.date === '2026-02-12');
      expect(wedSession?.tags).toContain('technique');

      // Check NoHardHard was applied
      const tueSession = result.sessions.find(s => s.date === '2026-02-11');
      expect(tueSession?.intensity).toBe(Intensity.z2);

      // Check WeeklyLoadCap was applied
      const totalMinutes = result.sessions.reduce((sum, s) => sum + s.durationMin, 0);
      expect(totalMinutes).toBeLessThanOrEqual(220);

      // All three rules should be in appliedRules
      expect(result.appliedRules.length).toBeGreaterThanOrEqual(3);
    });
  });
});
