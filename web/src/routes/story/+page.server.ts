import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

const MAX_THREAD_ID_LENGTH = 256;

function readThreadId(value: string | null): string {
	if (!value) {
		throw error(400, 'threadId query parameter is required');
	}

	const threadId = value.trim();
	if (!threadId || threadId.length > MAX_THREAD_ID_LENGTH) {
		throw error(400, 'threadId query parameter is invalid');
	}

	return threadId;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.session) {
		throw redirect(302, '/auth/google');
	}

	const threadId = readThreadId(url.searchParams.get('threadId'));

	return {
		threadId
	};
};
