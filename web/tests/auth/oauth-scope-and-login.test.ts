import { describe, expect, it, beforeEach, vi } from 'vitest';
import { AUTH_SCOPES, GMAIL_READONLY_SCOPE } from '../../src/lib/server/auth/scope-plan';
import { buildAuthorizationURL, google } from '../../src/lib/server/auth/oauth';
import { GET as startGoogleAuth } from '../../src/routes/auth/google/+server';
import { GET as oauthCallback } from '../../src/routes/auth/google/callback/+server';
import {
	OAUTH_CODE_VERIFIER_COOKIE,
	OAUTH_STATE_COOKIE,
	SESSION_COOKIE
} from '../../src/lib/server/auth/session';
import { handle } from '../../src/hooks.server';

const mockPrivateEnv = vi.hoisted(() => ({
	GOOGLE_CLIENT_ID: undefined as string | undefined,
	GOOGLE_CLIENT_SECRET: undefined as string | undefined
}));

vi.mock('$env/static/private', () => ({
	get GOOGLE_CLIENT_ID() {
		return mockPrivateEnv.GOOGLE_CLIENT_ID;
	},
	get GOOGLE_CLIENT_SECRET() {
		return mockPrivateEnv.GOOGLE_CLIENT_SECRET;
	}
}));

type CookieOptions = {
	httpOnly?: boolean;
	sameSite?: 'lax' | 'strict' | 'none';
	path?: string;
	maxAge?: number;
	secure?: boolean;
};

class CookieJar {
	private readonly values = new Map<string, string>();
	public readonly setCalls: Array<{ name: string; value: string; options: CookieOptions }> = [];
	public readonly deleteCalls: Array<{ name: string; options: CookieOptions | undefined }> = [];

	get(name: string): string | undefined {
		return this.values.get(name);
	}

	set(name: string, value: string, options: CookieOptions): void {
		this.values.set(name, value);
		this.setCalls.push({ name, value, options });
	}

	delete(name: string, options?: CookieOptions): void {
		this.values.delete(name);
		this.deleteCalls.push({ name, options });
	}
}

function encodeFakeIdToken(payload: Record<string, string>): string {
	return `header.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.signature`;
}

describe('Google OAuth scope plan', () => {
	it('always requests gmail.readonly in the auth scope set', () => {
		expect(AUTH_SCOPES).toContain('openid');
		expect(AUTH_SCOPES).toContain('email');
		expect(AUTH_SCOPES).toContain('profile');
		expect(AUTH_SCOPES).toContain(GMAIL_READONLY_SCOPE);
	});
});

describe('Arctic OAuth authorization URL builder', () => {
	beforeEach(() => {
		mockPrivateEnv.GOOGLE_CLIENT_ID = 'client-id';
		mockPrivateEnv.GOOGLE_CLIENT_SECRET = 'client-secret';
	});

	it('builds URL with readonly Gmail scope', () => {
		const { url, codeVerifier, state } = buildAuthorizationURL(
			new URL('http://localhost:5173/auth/google')
		);

		expect(state.length).toBeGreaterThan(20);
		expect(codeVerifier.length).toBeGreaterThan(20);
		expect(url.searchParams.has('include_granted_scopes')).toBe(false);
		expect(url.searchParams.get('access_type')).toBe('offline');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('prompt')).toBe('consent');

		const scopes = (url.searchParams.get('scope') ?? '').split(' ');
		expect(scopes).toContain(GMAIL_READONLY_SCOPE);
	});
});

describe('Google OAuth auth start route', () => {
	beforeEach(() => {
		mockPrivateEnv.GOOGLE_CLIENT_ID = 'client-id';
		mockPrivateEnv.GOOGLE_CLIENT_SECRET = 'client-secret';
		vi.restoreAllMocks();
	});

	it('returns a setup error when OAuth env vars are missing', async () => {
		mockPrivateEnv.GOOGLE_CLIENT_ID = undefined;
		mockPrivateEnv.GOOGLE_CLIENT_SECRET = undefined;

		const response = await startGoogleAuth({
			url: new URL('http://localhost:5173/auth/google'),
			cookies: new CookieJar()
		} as never);

		expect(response.status).toBe(503);

		const payload = (await response.json()) as {
			error: string;
			missing: string[];
			message: string;
		};

		expect(payload.error).toBe('google_oauth_not_configured');
		expect(payload.missing).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
	});

	it('builds a consent URL that includes gmail.readonly', async () => {
		const cookies = new CookieJar();

		const response = await startGoogleAuth({
			url: new URL('http://localhost:5173/auth/google'),
			cookies
		} as never);

		expect(response.status).toBe(302);

		const location = response.headers.get('location');
		expect(location).toBeTruthy();

		const redirect = new URL(location ?? '');
		expect(redirect.searchParams.has('include_granted_scopes')).toBe(false);
		expect(redirect.searchParams.get('state')).toBeTruthy();
		expect(redirect.searchParams.get('code_challenge_method')).toBe('S256');

		const scopes = (redirect.searchParams.get('scope') ?? '').split(' ');
		expect(scopes).toContain(GMAIL_READONLY_SCOPE);

		const cookieNames = cookies.setCalls.map((call) => call.name);
		expect(cookieNames).toContain(OAUTH_STATE_COOKIE);
		expect(cookieNames).toContain(OAUTH_CODE_VERIFIER_COOKIE);
		expect(cookies.setCalls.every((call) => call.options.httpOnly === true)).toBe(true);
	});

	it('uses deployment base path when generating redirect_uri', async () => {
		const response = await startGoogleAuth({
			url: new URL('https://example.com/memories/auth/google'),
			cookies: new CookieJar()
		} as never);

		const location = response.headers.get('location');
		expect(location).toBeTruthy();

		const redirect = new URL(location ?? '');
		expect(redirect.searchParams.get('redirect_uri')).toBe(
			'https://example.com/memories/auth/google/callback'
		);
	});
});

describe('Google OAuth callback', () => {
	beforeEach(() => {
		mockPrivateEnv.GOOGLE_CLIENT_ID = 'client-id';
		mockPrivateEnv.GOOGLE_CLIENT_SECRET = 'client-secret';
	});

	it('rejects callbacks when state does not match', async () => {
		const cookies = new CookieJar();
		cookies.set(OAUTH_STATE_COOKIE, 'expected-state', { path: '/' });
		cookies.set(OAUTH_CODE_VERIFIER_COOKIE, 'verifier-1', { path: '/' });

		const response = await oauthCallback({
			url: new URL('http://localhost:5173/auth/google/callback?code=code-1&state=wrong-state'),
			cookies,
			fetch: vi.fn()
		} as never);

		expect(response.status).toBe(400);
		expect(cookies.setCalls.some((call) => call.name === SESSION_COOKIE)).toBe(false);
	});

	it('rejects callbacks when the code_verifier cookie is missing', async () => {
		const cookies = new CookieJar();
		cookies.set(OAUTH_STATE_COOKIE, 'state-123', { path: '/' });

		const response = await oauthCallback({
			url: new URL('http://localhost:5173/auth/google/callback?code=code-1&state=state-123'),
			cookies,
			fetch: vi.fn()
		} as never);

		expect(response.status).toBe(400);
		expect(cookies.setCalls.some((call) => call.name === SESSION_COOKIE)).toBe(false);
		expect(cookies.deleteCalls.some((call) => call.name === OAUTH_STATE_COOKIE)).toBe(true);
	});

	it('sets a server-only session cookie for valid callbacks', async () => {
		const cookies = new CookieJar();
		cookies.set(OAUTH_STATE_COOKIE, 'state-123', { path: '/' });
		cookies.set(OAUTH_CODE_VERIFIER_COOKIE, 'verifier-123', { path: '/' });

		vi.spyOn(google, 'validateAuthorizationCode').mockResolvedValue({
			accessToken: () => 'access-token',
			hasRefreshToken: () => true,
			refreshToken: () => 'refresh-token',
			idToken: () =>
				encodeFakeIdToken({ sub: 'google-subject-1', email: 'person@example.com', name: 'Alex' }),
			hasScopes: () => true,
			scopes: () => ['openid', 'email', 'profile', GMAIL_READONLY_SCOPE]
		} as Awaited<ReturnType<typeof google.validateAuthorizationCode>>);

		const response = await oauthCallback({
			url: new URL('http://localhost:5173/auth/google/callback?code=code-1&state=state-123'),
			cookies
		} as never);

		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('http://localhost:5173/');

		const sessionSetCall = cookies.setCalls.find((call) => call.name === SESSION_COOKIE);
		expect(sessionSetCall).toBeDefined();
		expect(sessionSetCall?.options.httpOnly).toBe(true);
		expect(sessionSetCall?.value.length).toBeGreaterThan(20);
		expect(sessionSetCall?.value).not.toContain('access-token');
		expect(sessionSetCall?.value).not.toContain('refresh-token');
		expect(() =>
			JSON.parse(Buffer.from(sessionSetCall?.value ?? '', 'base64url').toString('utf8'))
		).toThrow();

		const localsEvent = {
			cookies,
			url: new URL('http://localhost:5173/'),
			locals: {
				session: null,
				user: null
			} as { session: { grantedScopes: string[] } | null; user: { subject: string } | null }
		};

		await handle({
			event: localsEvent,
			resolve: async () => new Response('ok')
		} as never);

		expect(localsEvent.locals.user).toMatchObject({
			subject: 'google-subject-1',
			email: 'person@example.com',
			name: 'Alex'
		});
		expect(localsEvent.locals.session?.grantedScopes).toContain(GMAIL_READONLY_SCOPE);

		expect(cookies.deleteCalls.some((call) => call.name === OAUTH_STATE_COOKIE)).toBe(true);
		expect(cookies.deleteCalls.some((call) => call.name === OAUTH_CODE_VERIFIER_COOKIE)).toBe(true);
	});

	it('rejects callbacks when granted scopes do not include gmail.readonly', async () => {
		const cookies = new CookieJar();
		cookies.set(OAUTH_STATE_COOKIE, 'state-123', { path: '/' });
		cookies.set(OAUTH_CODE_VERIFIER_COOKIE, 'verifier-123', { path: '/' });

		vi.spyOn(google, 'validateAuthorizationCode').mockResolvedValue({
			accessToken: () => 'access-token',
			hasRefreshToken: () => true,
			refreshToken: () => 'refresh-token',
			idToken: () =>
				encodeFakeIdToken({ sub: 'google-subject-1', email: 'person@example.com', name: 'Alex' }),
			hasScopes: () => true,
			scopes: () => ['openid', 'email', 'profile']
		} as Awaited<ReturnType<typeof google.validateAuthorizationCode>>);

		const response = await oauthCallback({
			url: new URL('http://localhost:5173/auth/google/callback?code=code-1&state=state-123'),
			cookies
		} as never);

		expect(response.status).toBe(403);
		expect(cookies.setCalls.some((call) => call.name === SESSION_COOKIE)).toBe(false);
	});
});
