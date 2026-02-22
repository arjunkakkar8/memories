import type { ScanCandidate } from '$lib/scan/candidate-store';

export function buildStoryHandoffHref(candidate: ScanCandidate | null | undefined): string | null {
	if (!candidate?.threadId) {
		return null;
	}

	const params = new URLSearchParams();
	params.set('threadId', candidate.threadId);

	const subject = candidate.metadata.subject?.trim();
	if (subject) {
		params.set('subject', subject);
	}

	if (candidate.metadata.participants.length > 0) {
		params.set('participants', candidate.metadata.participants.join(','));
	}

	return `/story?${params.toString()}`;
}
