export type StoryHandoffHints = {
	subject?: string;
	participants?: string[];
};

const SUBJECT_PARAM = 'seedSubject';
const PARTICIPANT_PARAM = 'seedParticipant';
const MAX_SUBJECT_LENGTH = 180;
const MAX_PARTICIPANTS = 8;

function sanitizeSubject(value: string | null | undefined): string | undefined {
	const normalized = (value ?? '').trim();
	if (!normalized) {
		return undefined;
	}

	return normalized.slice(0, MAX_SUBJECT_LENGTH);
}

function sanitizeParticipants(values: string[]): string[] {
	const deduped = new Set<string>();
	for (const value of values) {
		const normalized = value.trim().toLowerCase();
		if (!normalized || !normalized.includes('@')) {
			continue;
		}

		deduped.add(normalized);
		if (deduped.size >= MAX_PARTICIPANTS) {
			break;
		}
	}

	return [...deduped];
}

export function buildStoryHandoffHref(threadId: string, hints?: StoryHandoffHints): string {
	const pathname = `/story/${encodeURIComponent(threadId)}`;
	const subject = sanitizeSubject(hints?.subject);
	const participants = sanitizeParticipants(hints?.participants ?? []);

	if (!subject && participants.length === 0) {
		return pathname;
	}

	const params = new URLSearchParams();
	if (subject) {
		params.set(SUBJECT_PARAM, subject);
	}
	for (const participant of participants) {
		params.append(PARTICIPANT_PARAM, participant);
	}

	return `${pathname}?${params.toString()}`;
}

export function parseStoryHandoffHints(
	searchParams: URLSearchParams
): StoryHandoffHints | undefined {
	const subject = sanitizeSubject(searchParams.get(SUBJECT_PARAM));
	const participants = sanitizeParticipants(searchParams.getAll(PARTICIPANT_PARAM));

	if (!subject && participants.length === 0) {
		return undefined;
	}

	return {
		subject,
		participants: participants.length > 0 ? participants : undefined
	};
}
