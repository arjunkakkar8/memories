import { describe, expect, it } from 'vitest';
import { materializeGmailQuery } from '../../src/lib/server/scan/query-packs';
import { sampleRandomWindows } from '../../src/lib/server/scan/window-sampler';

describe('sampleRandomWindows', () => {
	it('generates windows inside bounds with valid durations', () => {
		const now = new Date('2026-02-22T00:00:00Z');
		const windows = sampleRandomWindows({
			now,
			count: 4,
			durationDaysOptions: [7, 30, 90],
			maxLookbackDays: 365,
			maxOverlapRatio: 1,
			randomFn: () => 0.5
		});

		expect(windows).toHaveLength(4);
		for (const window of windows) {
			expect(window.startEpochSec).toBeGreaterThan(0);
			expect(window.endEpochSec).toBeGreaterThan(window.startEpochSec);
			expect([7, 30, 90]).toContain(window.durationDays);
		}
	});
});

describe('materializeGmailQuery', () => {
	it('appends epoch-based after/before operators', () => {
		const query = materializeGmailQuery(
			{
				id: 'pack-1',
				name: 'Pack 1',
				query: 'in:inbox -category:promotions'
			},
			{
				id: 'window-1',
				startEpochSec: 1_700_000_000,
				endEpochSec: 1_700_086_400,
				durationDays: 1
			}
		);

		expect(query).toContain('in:inbox');
		expect(query).toContain('after:1700000000');
		expect(query).toContain('before:1700086400');
	});
});
