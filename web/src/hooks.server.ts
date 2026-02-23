import { redirect, type Handle } from '@sveltejs/kit';
import {
	deleteSessionTokenCookie,
	SESSION_COOKIE,
	setSessionTokenCookie,
	validateSessionToken
} from '$lib/server/auth/session';

export const handle: Handle = async ({ event, resolve }) => {
	const sessionToken = event.cookies.get(SESSION_COOKIE);
	const sessionValidation = validateSessionToken(sessionToken);
	const pathname = event.url.pathname;
	const isAuthRoute = pathname.startsWith('/auth');
	const isPublicRoute =
		pathname === '/privacy' || pathname.startsWith('/api') || pathname.startsWith('/_app');

	if (sessionToken && sessionValidation?.session) {
		setSessionTokenCookie(
			event.cookies,
			sessionToken,
			import.meta.env.PROD,
			sessionValidation.session.expiresAt
		);
	} else if (sessionToken) {
		deleteSessionTokenCookie(event.cookies, import.meta.env.PROD);
	}

	event.locals.session = sessionValidation?.session ?? null;
	event.locals.user = sessionValidation?.user ?? null;

	if (!event.locals.session && !isAuthRoute && !isPublicRoute) {
		throw redirect(302, '/auth/google');
	}

	return resolve(event);
};
