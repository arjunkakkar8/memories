import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrivateEnv = vi.hoisted(() => ({
	GOOGLE_CLIENT_ID: 'client-id',
	GOOGLE_CLIENT_SECRET: 'client-secret'
}));

vi.mock('$env/static/private', () => ({
	get GOOGLE_CLIENT_ID() {
		return mockPrivateEnv.GOOGLE_CLIENT_ID;
	},
	get GOOGLE_CLIENT_SECRET() {
		return mockPrivateEnv.GOOGLE_CLIENT_SECRET;
	}
}));

import {
	getAccessToken,
	getRefreshToken,
	rememberAccessToken,
	rememberRefreshToken
} from '../../src/lib/server/auth/revocable-token-store';
import { refreshGoogleAccessToken } from '../../src/lib/server/auth/google-token-refresh';
import { GET as oauthCallback } from '../../src/routes/auth/google/callback/+server';
import { google } from '../../src/lib/server/auth/oauth';
import { handle } from '../../src/hooks.server';
import { OAUTH_CODE_VERIFIER_COOKIE, OAUTH_STATE_COOKIE } from '../../src/lib/server/auth/session';

type CookieOptions = {
	httpOnly?: boolean;
	sameSite?: 'lax' | 'strict' | 'none';
	path?: string;
	maxAge?: number;
	secure?: boolean;
};

class CookieJar {
	private readonly values = new Map<string, string>();

	get(name: string): string | undefined {
		return this.values.get(name);
	}

	set(name: string, value: string, _options: CookieOptions): void {
		this.values.set(name, value);
	}

	delete(name: string): void {
		this.values.delete(name);
	}
}

function encodeFakeIdToken(payload: Record<string, string>): string {
	return `header.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.signature`;
}

describe('google token refresh primitives', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		mockPrivateEnv.GOOGLE_CLIENT_ID = 'client-id';
		mockPrivateEnv.GOOGLE_CLIENT_SECRET = 'client-secret';
	});

	it('refreshes access token through Google token endpoint', async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			expect(init?.method).toBe('POST');
			expect(init?.headers).toMatchObject({
				'content-type': 'application/x-www-form-urlencoded'
			});
			expect((init?.body as URLSearchParams).get('refresh_token')).toBe('refresh-token');

			return new Response(
				JSON.stringify({
					access_token: 'new-access-token',
					expires_in: 3600,
					scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly',
					token_type: 'Bearer'
				}),
				{ status: 200 }
			);
		});

		await expect(
			refreshGoogleAccessToken('refresh-token', {
				fetchImpl: fetchMock as never
			})
		).resolves.toMatchObject({
			accessToken: 'new-access-token',
			expiresIn: 3600,
			tokenType: 'Bearer'
		});
	});

	it('sends requested scopes in the refresh request body', async () => {
		let capturedBody: URLSearchParams | null = null;
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			capturedBody = init?.body as URLSearchParams;
			return new Response(
				JSON.stringify({
					access_token: 'new-access-token',
					expires_in: 3600,
					scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly',
					token_type: 'Bearer'
				}),
				{ status: 200 }
			);
		});

		await refreshGoogleAccessToken('refresh-token', {
			fetchImpl: fetchMock as never
		});

		expect(capturedBody).not.toBeNull();
		const scopeParam = capturedBody!.get('scope');
		expect(scopeParam).toBeTruthy();
		expect(scopeParam).toContain('https://www.googleapis.com/auth/gmail.readonly');
		expect(scopeParam).toContain('openid');
	});

	it('fails with stable error when Google token endpoint rejects refresh', async () => {
		const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));

		await expect(
			refreshGoogleAccessToken('refresh-token', {
				fetchImpl: fetchMock as never
			})
		).rejects.toThrowError('google_token_refresh_failed:401');
	});

	it('stores refresh token alongside access token for session-bound retrieval', async () => {
		const cookies = new CookieJar();
		cookies.set(OAUTH_STATE_COOKIE, 'state-1', { path: '/' });
		cookies.set(OAUTH_CODE_VERIFIER_COOKIE, 'verifier-1', { path: '/' });

		vi.spyOn(google, 'validateAuthorizationCode').mockResolvedValue({
			accessToken: () => 'google-access-token',
			hasRefreshToken: () => true,
			refreshToken: () => 'google-refresh-token',
			idToken: () =>
				encodeFakeIdToken({ sub: 'google-subject-1', email: 'person@example.com', name: 'Alex' }),
			hasScopes: () => true,
			scopes: () => ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly']
		} as Awaited<ReturnType<typeof google.validateAuthorizationCode>>);

		const response = await oauthCallback({
			url: new URL('http://localhost:5173/auth/google/callback?code=code-1&state=state-1'),
			cookies
		} as never);

		expect(response.status).toBe(302);

		const localsEvent = {
			cookies,
			url: new URL('http://localhost:5173/'),
			locals: {
				session: null,
				user: null
			}
		};

		await handle({
			event: localsEvent as never,
			resolve: async () => new Response('ok')
		} as never);

		const sessionId = localsEvent.locals.session?.id;
		expect(sessionId).toBeTruthy();
		expect(getRefreshToken(sessionId ?? '')).toBe('google-refresh-token');
		expect(getAccessToken(sessionId ?? '')).toBe('google-access-token');
	});

	it('supports direct in-memory token updates without exposing client storage', () => {
		rememberRefreshToken('session-1', 'refresh-1');
		rememberAccessToken('session-1', 'access-1');

		expect(getRefreshToken('session-1')).toBe('refresh-1');
		expect(getAccessToken('session-1')).toBe('access-1');
	});
});
