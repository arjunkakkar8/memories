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

	function enter(kind: 'gmail' | 'llm'): void {
		if (kind === 'gmail') {
			if (activeGmailRequests >= maxConcurrentGmail) {
				throw new QuotaBudgetError(
					'concurrency_exceeded',
					`Gmail concurrency limit reached (${maxConcurrentGmail})`
				);
			}

			activeGmailRequests += 1;
			return;
		}

		if (activeLlmRequests >= maxConcurrentLlm) {
			throw new QuotaBudgetError(
				'concurrency_exceeded',
				`LLM concurrency limit reached (${maxConcurrentLlm})`
			);
		}

		activeLlmRequests += 1;
	}

	function leave(kind: 'gmail' | 'llm'): void {
		if (kind === 'gmail') {
			activeGmailRequests = Math.max(0, activeGmailRequests - 1);
			return;
		}

		activeLlmRequests = Math.max(0, activeLlmRequests - 1);
	}

	async function withConcurrencySlot<T>(
		kind: 'gmail' | 'llm',
		operation: () => Promise<T>
	): Promise<T> {
		enter(kind);
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
