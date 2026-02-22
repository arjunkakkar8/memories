import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberRevocableToken } from '../../src/lib/server/auth/revocable-token-store';
import { POST as disconnect } from '../../src/routes/auth/google/disconnect/+server';
import {
	createSession,
	SESSION_COOKIE,
	setSessionTokenCookie,
	type AuthSession,
	validateSessionToken
} from '../../src/lib/server/auth/session';

type CookieOptions = {
	httpOnly?: boolean;
	sameSite?: boolean | 'lax' | 'strict' | 'none';
	path?: string;
	maxAge?: number;
	secure?: boolean;
};

class CookieJar {
	private readonly values = new Map<string, string>();
	public readonly events: string[] = [];
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
		this.events.push('clear');
		this.deleteCalls.push({ name, options });
	}
}

function seedSession(cookies: CookieJar): string {
	const session: AuthSession = {
		id: 'session-1',
		user: {
			subject: 'user-1',
			email: 'person@example.com',
			name: 'Person'
		},
		grantedScopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.metadata'],
		refreshTokenRef: 'abc123def456',
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 60_000).toISOString()
	};

	const createdSession = createSession(session);
	setSessionTokenCookie(cookies as never, createdSession.token, false, createdSession.session.expiresAt);
	const persisted = validateSessionToken(cookies.get(SESSION_COOKIE));
	if (!persisted?.session) {
		throw new Error('Expected test session to persist');
	}

	return persisted.session.id;
}

describe('Google OAuth disconnect route', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('revokes Google access before clearing the local session', async () => {
		const cookies = new CookieJar();
		const sessionId = seedSession(cookies);
		rememberRevocableToken(sessionId, 'google-refresh-token');

		const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
			async () => {
			cookies.events.push('revoke');
			return new Response('{}', { status: 200 });
			}
		);

		const response = await disconnect({
			request: new Request('http://localhost:5173/auth/google/disconnect', { method: 'POST' }),
			url: new URL('http://localhost:5173/auth/google/disconnect'),
			cookies,
			fetch: fetchMock
		} as never);

		expect(response.status).toBe(200);
		expect(cookies.events).toEqual(['revoke', 'clear']);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const firstCall = fetchMock.mock.calls[0];
		expect(firstCall?.[0]).toBe('https://oauth2.googleapis.com/revoke');
		const revokeInit = firstCall?.[1];
		expect(revokeInit?.method).toBe('POST');
		expect(revokeInit?.headers).toMatchObject({
			'content-type': 'application/x-www-form-urlencoded'
		});
		expect((revokeInit?.body as URLSearchParams).get('token')).toBe('google-refresh-token');

		expect(cookies.deleteCalls.some((call) => call.name === SESSION_COOKIE)).toBe(true);
	});

	it('still clears the local session when Google revoke fails', async () => {
		const cookies = new CookieJar();
		const sessionId = seedSession(cookies);
		rememberRevocableToken(sessionId, 'google-refresh-token');

		const fetchMock = vi.fn(async () => {
			cookies.events.push('revoke');
			return new Response('{}', { status: 503 });
		});

		const response = await disconnect({
			request: new Request('http://localhost:5173/auth/google/disconnect', { method: 'POST' }),
			url: new URL('http://localhost:5173/auth/google/disconnect'),
			cookies,
			fetch: fetchMock
		} as never);

		const payload = (await response.json()) as {
			revoke: { attempted: boolean; revoked: boolean; status: number | null; error: string | null };
		};

		expect(payload.revoke).toMatchObject({
			attempted: true,
			revoked: false,
			status: 503,
			error: 'google_revoke_503'
		});
		expect(cookies.deleteCalls.some((call) => call.name === SESSION_COOKIE)).toBe(true);
		expect(cookies.events).toEqual(['revoke', 'clear']);
	});

	it('leaves the user unauthenticated after disconnect', async () => {
		const cookies = new CookieJar();
		const sessionId = seedSession(cookies);
		rememberRevocableToken(sessionId, 'google-refresh-token');

		await disconnect({
			request: new Request('http://localhost:5173/auth/google/disconnect', { method: 'POST' }),
			url: new URL('http://localhost:5173/auth/google/disconnect'),
			cookies,
			fetch: vi.fn(async () => new Response('{}', { status: 200 }))
		} as never);

		expect(validateSessionToken(cookies.get(SESSION_COOKIE))).toBeNull();
	});
});
