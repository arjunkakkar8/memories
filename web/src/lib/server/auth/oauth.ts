import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from '$env/static/private';
import { Google, generateCodeVerifier, generateState } from 'arctic';
import { AUTH_SCOPES } from './scope-plan';

const REQUIRED_OAUTH_ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;
const GOOGLE_AUTH_START_PATH = '/auth/google';
const GOOGLE_AUTH_CALLBACK_PATH = '/auth/google/callback';

function hasGoogleOAuthConfig(): boolean {
	return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

export function getGoogleOAuthRedirectURI(currentUrl: URL): string {
	const normalizedPathname =
		currentUrl.pathname.length > 1 && currentUrl.pathname.endsWith('/')
			? currentUrl.pathname.slice(0, -1)
			: currentUrl.pathname;

	const basePath = normalizedPathname.endsWith(GOOGLE_AUTH_CALLBACK_PATH)
		? normalizedPathname.slice(0, -GOOGLE_AUTH_CALLBACK_PATH.length)
		: normalizedPathname.endsWith(GOOGLE_AUTH_START_PATH)
			? normalizedPathname.slice(0, -GOOGLE_AUTH_START_PATH.length)
			: '';

	return new URL(`${basePath}${GOOGLE_AUTH_CALLBACK_PATH}`, currentUrl).toString();
}

function createGoogleProvider(currentUrl: URL): Google {
	if (!hasGoogleOAuthConfig()) {
		throw new Error('Missing Google OAuth environment variables');
	}

	const redirectUri = getGoogleOAuthRedirectURI(currentUrl);
	return new Google(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri);
}

export const google = {
	createAuthorizationURL(
		state: string,
		codeVerifier: string,
		scopes: readonly string[],
		currentUrl: URL
	): URL {
		return createGoogleProvider(currentUrl).createAuthorizationURL(state, codeVerifier, [...scopes]);
	},
	validateAuthorizationCode(code: string, codeVerifier: string, currentUrl: URL) {
		return createGoogleProvider(currentUrl).validateAuthorizationCode(code, codeVerifier);
	}
};

export function getMissingGoogleOAuthConfigKeys(): string[] {
	return REQUIRED_OAUTH_ENV_KEYS.filter((key) => {
		if (key === 'GOOGLE_CLIENT_ID') return !GOOGLE_CLIENT_ID;
		return !GOOGLE_CLIENT_SECRET;
	});
}

export function buildAuthorizationURL(currentUrl: URL): {
	url: URL;
	state: string;
	codeVerifier: string;
} {
	if (!hasGoogleOAuthConfig()) {
		throw new Error('Missing Google OAuth environment variables');
	}

	const state = generateState();
	const codeVerifier = generateCodeVerifier();

	const url = google.createAuthorizationURL(state, codeVerifier, AUTH_SCOPES, currentUrl);
	url.searchParams.set('access_type', 'offline');
	url.searchParams.set('prompt', 'consent');

	return { url, state, codeVerifier };
}
