import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	return {
		user: locals.user,
		scanEnabled: Boolean(locals.user && locals.session)
	};
};
