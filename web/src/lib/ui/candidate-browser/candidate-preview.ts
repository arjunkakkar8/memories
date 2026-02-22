const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
	month: 'short',
	day: 'numeric',
	year: 'numeric',
	timeZone: 'UTC'
});

const PREVIEW_FALLBACK = 'A meaningful moment is waiting in this thread.';
const PREVIEW_MAX_LENGTH = 110;

function parseDate(value: string | null): Date | null {
	if (!value) {
		return null;
	}

	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function truncateLine(value: string): string {
	if (value.length <= PREVIEW_MAX_LENGTH) {
		return value;
	}

	return `${value.slice(0, PREVIEW_MAX_LENGTH - 3).trimEnd()}...`;
}

export function formatCandidateDateRange(
	firstMessageAt: string | null,
	lastMessageAt: string | null
): string {
	const first = parseDate(firstMessageAt);
	const last = parseDate(lastMessageAt);

	if (first && last) {
		const [start, end] = first.getTime() <= last.getTime() ? [first, last] : [last, first];
		if (typeof DATE_FORMATTER.formatRange === 'function') {
			return DATE_FORMATTER.formatRange(start, end);
		}

		return `${DATE_FORMATTER.format(start)} - ${DATE_FORMATTER.format(end)}`;
	}

	if (first) {
		return DATE_FORMATTER.format(first);
	}

	if (last) {
		return DATE_FORMATTER.format(last);
	}

	return 'Date unavailable';
}

export function toEmotionalPreview(latestSnippet: string | null): string {
	if (!latestSnippet) {
		return PREVIEW_FALLBACK;
	}

	const normalized = collapseWhitespace(latestSnippet);
	if (normalized.length === 0) {
		return PREVIEW_FALLBACK;
	}

	return truncateLine(normalized);
}
