import { forgetRevocableToken, getRevocableToken } from '$lib/server/auth/revocable-token-store';
import { revokeGoogleAccess } from '$lib/server/auth/revoke';
import { clearSession, SESSION_COOKIE, validateSessionToken } from '$lib/server/auth/session';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies, fetch }) => {
	const isSecure = import.meta.env.PROD;
	const sessionToken = cookies.get(SESSION_COOKIE);
	const sessionValidation = validateSessionToken(sessionToken);
	const session = sessionValidation?.session ?? null;
	const sessionId = session?.id;
	const revocableToken = sessionId ? getRevocableToken(sessionId) : null;
	const revokeResult = await revokeGoogleAccess({
		token: revocableToken,
		fetchImpl: fetch
	});

	clearSession(cookies, isSecure);
	if (sessionId) {
		forgetRevocableToken(sessionId);
	}

	return new Response(
		JSON.stringify({
			disconnected: true,
			hadSession: session !== null,
			grantedScopes: session?.grantedScopes ?? [],
			revoke: revokeResult
		}),
		{
			status: 200,
			headers: {
				'content-type': 'application/json'
			}
		}
	);
};
