import type { RankedScanCandidate, ScanPipelineProgress } from '$lib/server/scan/types';

export type ScanSseEvent =
	| {
			event: 'scan.started';
			data: {
				startedAt: string;
			};
	  }
	| {
			event: 'scan.progress';
			data: ScanPipelineProgress;
	  }
	| {
			event: 'scan.candidates';
			data: {
				batchIndex: number;
				candidates: RankedScanCandidate[];
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

export function toSseEvent(event: ScanSseEvent, id?: string): string {
	const lines = [];

	if (id) {
		lines.push(`id: ${id}`);
	}

	lines.push(`event: ${event.event}`);
	lines.push(`data: ${JSON.stringify(event.data)}`);

	return `${lines.join('\n')}\n\n`;
}
