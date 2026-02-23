const DEFAULT_GMAIL_UNITS = 5000;
const DEFAULT_MAX_CONCURRENT_GMAIL = 8;
const DEFAULT_MAX_CONCURRENT_LLM = 2;

export class QuotaBudgetError extends Error {
	readonly code: 'quota_exceeded' | 'concurrency_exceeded';

	constructor(code: 'quota_exceeded' | 'concurrency_exceeded', message: string) {
		super(message);
		this.name = 'QuotaBudgetError';
		this.code = code;
	}
}

type BudgetOptions = {
	maxGmailUnits?: number;
	maxConcurrentGmail?: number;
	maxConcurrentLlm?: number;
};

export type BudgetSnapshot = {
	maxGmailUnits: number;
	usedGmailUnits: number;
	remainingGmailUnits: number;
	activeGmailRequests: number;
	activeLlmRequests: number;
};

export function createQuotaBudget(options: BudgetOptions = {}) {
	const maxGmailUnits = options.maxGmailUnits ?? DEFAULT_GMAIL_UNITS;
	const maxConcurrentGmail = options.maxConcurrentGmail ?? DEFAULT_MAX_CONCURRENT_GMAIL;
	const maxConcurrentLlm = options.maxConcurrentLlm ?? DEFAULT_MAX_CONCURRENT_LLM;

	let usedGmailUnits = 0;
	let activeGmailRequests = 0;
	let activeLlmRequests = 0;
	const gmailQueue: Array<() => void> = [];
	const llmQueue: Array<() => void> = [];

	function snapshot(): BudgetSnapshot {
		return {
			maxGmailUnits,
			usedGmailUnits,
			remainingGmailUnits: Math.max(0, maxGmailUnits - usedGmailUnits),
			activeGmailRequests,
			activeLlmRequests
		};
	}

	function consumeGmailUnits(units: number): BudgetSnapshot {
		if (units <= 0) {
			return snapshot();
		}

		if (usedGmailUnits + units > maxGmailUnits) {
			throw new QuotaBudgetError(
				'quota_exceeded',
				`Quota budget exceeded: requested ${units} units with ${Math.max(0, maxGmailUnits - usedGmailUnits)} units left`
			);
		}

		usedGmailUnits += units;
		return snapshot();
	}

	function acquire(kind: 'gmail' | 'llm'): Promise<void> {
		if (kind === 'gmail') {
			if (activeGmailRequests < maxConcurrentGmail) {
				activeGmailRequests += 1;
				return Promise.resolve();
			}

			return new Promise((resolve) => {
				gmailQueue.push(() => {
					activeGmailRequests += 1;
					resolve();
				});
			});
		}

		if (activeLlmRequests < maxConcurrentLlm) {
			activeLlmRequests += 1;
			return Promise.resolve();
		}

		return new Promise((resolve) => {
			llmQueue.push(() => {
				activeLlmRequests += 1;
				resolve();
			});
		});
	}

	function leave(kind: 'gmail' | 'llm'): void {
		if (kind === 'gmail') {
			activeGmailRequests = Math.max(0, activeGmailRequests - 1);
			const next = gmailQueue.shift();
			if (next) {
				next();
			}
			return;
		}

		activeLlmRequests = Math.max(0, activeLlmRequests - 1);
		const next = llmQueue.shift();
		if (next) {
			next();
		}
	}

	async function withConcurrencySlot<T>(
		kind: 'gmail' | 'llm',
		operation: () => Promise<T>
	): Promise<T> {
		await acquire(kind);
		try {
			return await operation();
		} finally {
			leave(kind);
		}
	}

	return {
		snapshot,
		consumeGmailUnits,
		withConcurrencySlot
	};
}

export type QuotaBudget = ReturnType<typeof createQuotaBudget>;
