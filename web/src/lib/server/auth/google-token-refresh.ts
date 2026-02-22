import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from '$env/static/private';
import { AUTH_SCOPES } from './scope-plan';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

type RefreshTokenOptions = {
	fetchImpl?: typeof fetch;
};

type GoogleRefreshTokenResponse = {
	access_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
};

export type RefreshedGoogleToken = {
	accessToken: string;
	expiresIn: number | null;
	scope: string | null;
	tokenType: string | null;
};

export async function refreshGoogleAccessToken(
	refreshToken: string,
	options: RefreshTokenOptions = {}
): Promise<RefreshedGoogleToken> {
	if (!refreshToken) {
		throw new Error('google_refresh_token_missing');
	}

	if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
		throw new Error('google_oauth_not_configured');
	}

	const fetchImpl = options.fetchImpl ?? fetch;
	const body = new URLSearchParams({
		client_id: GOOGLE_CLIENT_ID,
		client_secret: GOOGLE_CLIENT_SECRET,
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		scope: AUTH_SCOPES.join(' ')
	});

	const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded'
		},
		body
	});

	if (!response.ok) {
		throw new Error(`google_token_refresh_failed:${response.status}`);
	}

	const payload = (await response.json()) as GoogleRefreshTokenResponse;
	if (!payload.access_token) {
		throw new Error('google_token_refresh_missing_access_token');
	}

	return {
		accessToken: payload.access_token,
		expiresIn: payload.expires_in ?? null,
		scope: payload.scope ?? null,
		tokenType: payload.token_type ?? null
	};
}
