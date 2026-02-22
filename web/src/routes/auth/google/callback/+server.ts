import {
	rememberAccessToken,
	rememberRefreshToken,
	rememberRevocableToken
} from '$lib/server/auth/revocable-token-store';
import { google } from '$lib/server/auth/oauth';
import {
	buildSessionFromTokens,
	clearOAuthCodeVerifier,
	clearOAuthState,
	createSession,
	getOAuthCodeVerifier,
	getOAuthState,
	setSessionTokenCookie
} from '$lib/server/auth/session';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const state = url.searchParams.get('state');
	const code = url.searchParams.get('code');
	const expectedState = getOAuthState(cookies);
	const codeVerifier = getOAuthCodeVerifier(cookies);
	const isSecure = import.meta.env.PROD;
	const clearOAuthCookies = () => {
		clearOAuthState(cookies, isSecure);
		clearOAuthCodeVerifier(cookies, isSecure);
	};

	if (!state || !code || !expectedState || !codeVerifier || state !== expectedState) {
		clearOAuthCookies();
		return new Response('Invalid OAuth state', { status: 400 });
	}

	try {
		const oauthTokens = await google.validateAuthorizationCode(code, codeVerifier);

		const tokens = {
			access_token: oauthTokens.accessToken(),
			refresh_token: oauthTokens.hasRefreshToken() ? oauthTokens.refreshToken() : undefined,
			id_token: oauthTokens.idToken(),
			scope: oauthTokens.hasScopes() ? oauthTokens.scopes().join(' ') : undefined
		};

		const session = buildSessionFromTokens(tokens);
		const revocableToken = tokens.refresh_token ?? tokens.access_token;
		const createdSession = createSession(session);
		rememberRevocableToken(createdSession.session.id, revocableToken);
		if (tokens.refresh_token) {
			rememberRefreshToken(createdSession.session.id, tokens.refresh_token);
		}
		rememberAccessToken(createdSession.session.id, tokens.access_token);
		setSessionTokenCookie(cookies, createdSession.token, isSecure, createdSession.session.expiresAt);
		clearOAuthCookies();

		return new Response(null, {
			status: 302,
			headers: {
				location: new URL('/', url).toString()
			}
		});
	} catch {
		clearOAuthCookies();
		return new Response('Please restart the process.', { status: 400 });
	}
};
