type SessionTokenRecord = {
	revocableToken: string | null;
	accessToken: string | null;
	accessTokenScopes: string[] | null;
	refreshToken: string | null;
	createdAt: string;
};

const sessionTokenStore = new Map<string, SessionTokenRecord>();

function ensureRecord(sessionId: string): SessionTokenRecord {
	const existing = sessionTokenStore.get(sessionId);
	if (existing) {
		return existing;
	}

	const created: SessionTokenRecord = {
		revocableToken: null,
		accessToken: null,
		accessTokenScopes: null,
		refreshToken: null,
		createdAt: new Date().toISOString()
	};
	sessionTokenStore.set(sessionId, created);
	return created;
}

export function rememberRevocableToken(sessionId: string, token: string): void {
	if (!sessionId || !token) {
		return;
	}

	const record = ensureRecord(sessionId);
	record.revocableToken = token;
}

export function getRevocableToken(sessionId: string): string | null {
	return sessionTokenStore.get(sessionId)?.revocableToken ?? null;
}

export function rememberAccessToken(sessionId: string, token: string, scopes?: string[]): void {
	if (!sessionId || !token) {
		return;
	}

	const record = ensureRecord(sessionId);
	record.accessToken = token;
	record.accessTokenScopes = scopes ?? null;
}

export function getAccessTokenScopes(sessionId: string): string[] | null {
	return sessionTokenStore.get(sessionId)?.accessTokenScopes ?? null;
}

export function getAccessToken(sessionId: string): string | null {
	return sessionTokenStore.get(sessionId)?.accessToken ?? null;
}

export function rememberRefreshToken(sessionId: string, token: string): void {
	if (!sessionId || !token) {
		return;
	}

	const record = ensureRecord(sessionId);
	record.refreshToken = token;
}

export function getRefreshToken(sessionId: string): string | null {
	return sessionTokenStore.get(sessionId)?.refreshToken ?? null;
}

export function forgetRevocableToken(sessionId: string): void {
	sessionTokenStore.delete(sessionId);
}
