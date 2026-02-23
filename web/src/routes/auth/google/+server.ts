import { buildAuthorizationURL, getMissingGoogleOAuthConfigKeys } from '$lib/server/auth/oauth';
import { setOAuthCodeVerifier, setOAuthState } from '$lib/server/auth/session';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url, cookies }) => {
	try {
		const { url: authorizationUrl, state, codeVerifier } = buildAuthorizationURL(url);
		const isSecure = import.meta.env.PROD;

		setOAuthState(cookies, state, isSecure);
		setOAuthCodeVerifier(cookies, codeVerifier, isSecure);

		return new Response(null, {
			status: 302,
			headers: {
				location: authorizationUrl.toString()
			}
		});
	} catch {
		const missing = getMissingGoogleOAuthConfigKeys();

		return new Response(
			JSON.stringify({
				error: 'google_oauth_not_configured',
				missing,
				message: 'Set Google OAuth environment variables before starting /auth/google.'
			}),
			{
				status: 503,
				headers: {
					'content-type': 'application/json'
				}
			}
		);
	}
};
