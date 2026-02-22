export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const OIDC_SCOPES = ['openid', 'email', 'profile'] as const;

export const AUTH_SCOPES = [...OIDC_SCOPES, GMAIL_READONLY_SCOPE] as const;

export function hasRequiredGmailScope(scopes: readonly string[] | null | undefined): boolean {
	if (!scopes || scopes.length === 0) {
		return false;
	}

	return scopes.includes(GMAIL_READONLY_SCOPE);
}
