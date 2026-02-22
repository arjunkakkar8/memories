import { writable, type Readable } from 'svelte/store';

export type ScanProgress = {
	stage: 'fetch' | 'heuristics' | 'llm' | 'complete';
	processed: number;
	total: number;
	message: string;
};

export type ScanCandidate = {
	threadId: string;
	metadata: {
		subject: string | null;
		participants: string[];
		messageCount: number;
		firstMessageAt: string | null;
		lastMessageAt: string | null;
		latestSnippet: string | null;
	};
	combinedScore: number;
	rank: number;
};

export type ScanRunStatus = 'idle' | 'running' | 'success' | 'error';

export type ScanStoreState = {
	runId: number;
	status: ScanRunStatus;
	startedAt: string | null;
	completedAt: string | null;
	progress: ScanProgress | null;
	candidates: ScanCandidate[];
	totalCandidates: number;
	error: {
		code: string;
		message: string;
		recoverable: boolean;
	} | null;
};

export type ScanClientEvent =
	| {
			event: 'scan.started';
			data: {
				startedAt: string;
			};
	  }
	| {
			event: 'scan.progress';
			data: ScanProgress;
	  }
	| {
			event: 'scan.candidates';
			data: {
				batchIndex: number;
				candidates: ScanCandidate[];
			};
	  }
	| {
			event: 'scan.complete';
			data: {
				completedAt: string;
				totalCandidates: number;
			};
	  }
	| {
			event: 'scan.error';
			data: {
				code: string;
				message: string;
				recoverable: boolean;
			};
	  }
	| {
			event: 'scan.keepalive';
			data: {
				timestamp: string;
			};
	  };

export type CandidateStore = Readable<ScanStoreState> & {
	startRun: () => number;
	applyEvent: (runId: number, event: ScanClientEvent) => void;
	setRunError: (runId: number, message: string) => void;
};

const INITIAL_STATE: ScanStoreState = {
	runId: 0,
	status: 'idle',
	startedAt: null,
	completedAt: null,
	progress: null,
	candidates: [],
	totalCandidates: 0,
	error: null
};

function appendUniqueCandidates(existing: ScanCandidate[], incoming: ScanCandidate[]): ScanCandidate[] {
	const seen = new Set(existing.map((candidate) => candidate.threadId));
	const next = [...existing];

	for (const candidate of incoming) {
		if (!seen.has(candidate.threadId)) {
			next.push(candidate);
			seen.add(candidate.threadId);
		}
	}

	return next;
}

export function createCandidateStore(): CandidateStore {
	let currentRunId = 0;
	const store = writable<ScanStoreState>(INITIAL_STATE);

	return {
		subscribe: store.subscribe,
		startRun: () => {
			currentRunId += 1;
			store.set({
				runId: currentRunId,
				status: 'running',
				startedAt: null,
				completedAt: null,
				progress: null,
				candidates: [],
				totalCandidates: 0,
				error: null
			});

			return currentRunId;
		},
		applyEvent: (runId, event) => {
			store.update((state) => {
				if (state.runId !== runId) {
					return state;
				}

				switch (event.event) {
					case 'scan.started':
						return {
							...state,
							status: 'running',
							startedAt: event.data.startedAt
						};
					case 'scan.progress':
						return {
							...state,
							status: 'running',
							progress: event.data
						};
					case 'scan.candidates':
						return {
							...state,
							status: 'running',
							candidates: appendUniqueCandidates(state.candidates, event.data.candidates)
						};
					case 'scan.complete':
						return {
							...state,
							status: 'success',
							completedAt: event.data.completedAt,
							totalCandidates: event.data.totalCandidates,
							progress: {
								stage: 'complete',
								processed: event.data.totalCandidates,
								total: event.data.totalCandidates,
								message: 'Scan complete'
							}
						};
					case 'scan.error':
						return {
							...state,
							status: 'error',
							error: event.data
						};
					case 'scan.keepalive':
						return state;
				}
			});
		},
		setRunError: (runId, message) => {
			store.update((state) => {
				if (state.runId !== runId || state.status === 'error') {
					return state;
				}

				return {
					...state,
					status: 'error',
					error: {
						code: 'scan_client_error',
						message,
						recoverable: true
					}
				};
			});
		}
	};
}
