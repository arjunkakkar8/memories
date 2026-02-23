import { describe, expect, it } from 'vitest';
import { createQuotaBudget } from '../../src/lib/server/scan/quota-budget';

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((res) => {
		resolve = res;
	});

	return { promise, resolve };
}

describe('createQuotaBudget', () => {
	it('queues requests above the concurrency cap instead of throwing', async () => {
		const budget = createQuotaBudget({ maxConcurrentGmail: 2 });
		const blockers = Array.from({ length: 5 }, () => deferred());
		let active = 0;
		let maxObserved = 0;

		const tasks = blockers.map((blocker) =>
			budget.withConcurrencySlot('gmail', async () => {
				active += 1;
				maxObserved = Math.max(maxObserved, active);
				await blocker.promise;
				active -= 1;
			})
		);

		await Promise.resolve();
		expect(maxObserved).toBe(2);

		for (const blocker of blockers) {
			blocker.resolve();
			await Promise.resolve();
		}

		await expect(Promise.all(tasks)).resolves.toBeDefined();
		expect(maxObserved).toBe(2);
		expect(budget.snapshot().activeGmailRequests).toBe(0);
	});
});
