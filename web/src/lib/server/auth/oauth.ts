import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } from '$env/static/private';
import { Google, generateCodeVerifier, generateState } from 'arctic';
import { AUTH_SCOPES } from './scope-plan';

const REQUIRED_OAUTH_ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const;

function hasGoogleOAuthConfig(): boolean {
	return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);
}

function createGoogleProvider(): Google {
	if (!hasGoogleOAuthConfig()) {
		throw new Error('Missing Google OAuth environment variables');
	}

	return new Google(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

export const google = {
	createAuthorizationURL(state: string, codeVerifier: string, scopes: readonly string[]): URL {
		return createGoogleProvider().createAuthorizationURL(state, codeVerifier, [...scopes]);
	},
	validateAuthorizationCode(code: string, codeVerifier: string) {
		return createGoogleProvider().validateAuthorizationCode(code, codeVerifier);
	}
};

export function getMissingGoogleOAuthConfigKeys(): string[] {
	return REQUIRED_OAUTH_ENV_KEYS.filter((key) => {
		if (key === 'GOOGLE_CLIENT_ID') return !GOOGLE_CLIENT_ID;
		if (key === 'GOOGLE_CLIENT_SECRET') return !GOOGLE_CLIENT_SECRET;
		return !GOOGLE_REDIRECT_URI;
	});
}

export function buildAuthorizationURL(): {
	url: URL;
	state: string;
	codeVerifier: string;
} {
	if (!hasGoogleOAuthConfig()) {
		throw new Error('Missing Google OAuth environment variables');
	}

	const state = generateState();
	const codeVerifier = generateCodeVerifier();

	const url = google.createAuthorizationURL(state, codeVerifier, AUTH_SCOPES);
	url.searchParams.set('access_type', 'offline');
	url.searchParams.set('include_granted_scopes', 'true');
	url.searchParams.set('prompt', 'consent');

	return { url, state, codeVerifier };
}
