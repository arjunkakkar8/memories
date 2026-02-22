import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';

export const OAUTH_STATE_COOKIE = 'memories_oauth_state';
export const OAUTH_CODE_VERIFIER_COOKIE = 'memories_oauth_code_verifier';
export const SESSION_COOKIE = 'memories_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export type SessionUser = {
	subject: string;
	email: string | null;
	name: string | null;
};

export type AuthSession = {
	id: string;
	user: SessionUser;
	grantedScopes: string[];
	refreshTokenRef: string | null;
	createdAt: string;
	expiresAt: string;
};

type GoogleOAuthTokenPayload = {
	access_token: string;
	refresh_token?: string;
	id_token?: string;
	scope?: string;
};

const sessionStore = new Map<string, AuthSession>();

type CookieWriter = Pick<Cookies, 'set' | 'get' | 'delete'>;

function baseCookieOptions(isSecure: boolean) {
	return {
		httpOnly: true,
		sameSite: 'lax' as const,
		path: '/',
		secure: isSecure
	};
}

function toBase64Url(value: string): string {
	return Buffer.from(value, 'utf8').toString('base64url');
}

function fromBase64Url(value: string): string {
	return Buffer.from(value, 'base64url').toString('utf8');
}

export function setOAuthState(cookies: CookieWriter, state: string, isSecure: boolean): void {
	cookies.set(OAUTH_STATE_COOKIE, state, {
		...baseCookieOptions(isSecure),
		maxAge: 10 * 60
	});
}

export function getOAuthState(cookies: CookieWriter): string | undefined {
	return cookies.get(OAUTH_STATE_COOKIE);
}

export function clearOAuthState(cookies: CookieWriter, isSecure: boolean): void {
	cookies.delete(OAUTH_STATE_COOKIE, baseCookieOptions(isSecure));
}

export function setOAuthCodeVerifier(cookies: CookieWriter, codeVerifier: string, isSecure: boolean): void {
	cookies.set(OAUTH_CODE_VERIFIER_COOKIE, codeVerifier, {
		...baseCookieOptions(isSecure),
		maxAge: 10 * 60
	});
}

export function getOAuthCodeVerifier(cookies: CookieWriter): string | undefined {
	return cookies.get(OAUTH_CODE_VERIFIER_COOKIE);
}

export function clearOAuthCodeVerifier(cookies: CookieWriter, isSecure: boolean): void {
	cookies.delete(OAUTH_CODE_VERIFIER_COOKIE, baseCookieOptions(isSecure));
}

function decodeIdTokenPayload(idToken?: string): Partial<SessionUser> {
	if (!idToken) {
		return {};
	}

	const tokenParts = idToken.split('.');
	if (tokenParts.length < 2) {
		return {};
	}

	try {
		const payload = JSON.parse(fromBase64Url(tokenParts[1] ?? '')) as {
			sub?: string;
			email?: string;
			name?: string;
		};

		return {
			subject: payload.sub,
			email: payload.email ?? null,
			name: payload.name ?? null
		};
	} catch {
		return {};
	}
}

function makeRefreshTokenRef(refreshToken?: string): string | null {
	if (!refreshToken) {
		return null;
	}

	return createHash('sha256').update(refreshToken).digest('hex').slice(0, 16);
}

function hashSessionToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

function sessionExpirationFromNow(): string {
	return new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
}

function normalizeSessionId(session: AuthSession): AuthSession {
	const id = session.id || randomUUID();
	return {
		...session,
		id,
		expiresAt: session.expiresAt || sessionExpirationFromNow()
	};
}

function persistSession(sessionToken: string, session: AuthSession): void {
	sessionStore.set(hashSessionToken(sessionToken), normalizeSessionId(session));
}

function forgetSession(sessionToken: string): void {
	sessionStore.delete(hashSessionToken(sessionToken));
}

export function buildSessionFromTokens(tokens: GoogleOAuthTokenPayload): AuthSession {
	const claims = decodeIdTokenPayload(tokens.id_token);
	const id = randomUUID();

	return {
		id,
		user: {
			subject: claims.subject ?? 'google-user',
			email: claims.email ?? null,
			name: claims.name ?? null
		},
		grantedScopes: (tokens.scope ?? '').split(' ').filter(Boolean),
		refreshTokenRef: makeRefreshTokenRef(tokens.refresh_token),
		createdAt: new Date().toISOString(),
		expiresAt: sessionExpirationFromNow()
	};
}

export function createSession(session: AuthSession): { token: string; session: AuthSession } {
	const normalized = normalizeSessionId(session);
	const token = randomBytes(32).toString('base64url');
	persistSession(token, normalized);
	return { token, session: normalized };
}

export function validateSessionToken(
	token: string | null | undefined
): { session: AuthSession; user: SessionUser } | null {
	if (!token) {
		return null;
	}

	const session = sessionStore.get(hashSessionToken(token));
	if (!session) {
		return null;
	}

	if (new Date(session.expiresAt).getTime() <= Date.now()) {
		sessionStore.delete(hashSessionToken(token));
		return null;
	}

	return { session, user: session.user };
}

export function setSessionTokenCookie(
	cookies: CookieWriter,
	token: string,
	isSecure: boolean,
	expiresAt: string
): void {
	const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
	cookies.set(SESSION_COOKIE, token, {
		...baseCookieOptions(isSecure),
		maxAge
	});
}

export function deleteSessionTokenCookie(cookies: CookieWriter, isSecure: boolean): void {
	cookies.delete(SESSION_COOKIE, baseCookieOptions(isSecure));
}

export function clearSession(cookies: CookieWriter, isSecure: boolean): void {
	const raw = cookies.get(SESSION_COOKIE);
	if (raw) {
		forgetSession(raw);
	}
	deleteSessionTokenCookie(cookies, isSecure);
}
