import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

const MAX_THREAD_ID_LENGTH = 256;

function readThreadId(value: string | undefined): string {
	const threadId = value?.trim() ?? '';
	if (!threadId || threadId.length > MAX_THREAD_ID_LENGTH) {
		throw error(400, 'threadId route parameter is invalid');
	}

	return threadId;
}

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.session) {
		throw redirect(302, '/auth/google');
	}

	const threadId = readThreadId(params.threadId);

	return {
		threadId
	};
};
