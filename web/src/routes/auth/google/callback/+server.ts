import {
	rememberAccessToken,
	rememberRefreshToken,
	rememberRevocableToken
} from '$lib/server/auth/revocable-token-store';
import { google } from '$lib/server/auth/oauth';
import { hasRequiredGmailScope } from '$lib/server/auth/scope-plan';
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
		const oauthTokens = await google.validateAuthorizationCode(code, codeVerifier, url);

		const tokens = {
			access_token: oauthTokens.accessToken(),
			refresh_token: oauthTokens.hasRefreshToken() ? oauthTokens.refreshToken() : undefined,
			id_token: oauthTokens.idToken(),
			scope: oauthTokens.hasScopes() ? oauthTokens.scopes().join(' ') : undefined
		};

		const grantedScopes = (tokens.scope ?? '').split(' ').filter(Boolean);
		console.info(
			JSON.stringify({
				ts: new Date().toISOString(),
				level: 'info',
				event: 'auth.google.callback.scopes_received',
				hasRefreshToken: Boolean(tokens.refresh_token),
				grantedScopes
			})
		);
		if (!hasRequiredGmailScope(grantedScopes)) {
			console.warn(
				JSON.stringify({
					ts: new Date().toISOString(),
					level: 'warn',
					event: 'auth.google.callback.missing_required_scope',
					grantedScopes,
					scopeFieldPresent: oauthTokens.hasScopes()
				})
			);
			clearOAuthCookies();
			return new Response('Missing required Gmail readonly scope. Please reconnect Google.', { status: 403 });
		}

		const session = buildSessionFromTokens(tokens);
		const revocableToken = tokens.refresh_token ?? tokens.access_token;
		const createdSession = createSession(session);
		rememberRevocableToken(createdSession.session.id, revocableToken);
		if (tokens.refresh_token) {
			rememberRefreshToken(createdSession.session.id, tokens.refresh_token);
		}
		rememberAccessToken(createdSession.session.id, tokens.access_token, grantedScopes);
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
