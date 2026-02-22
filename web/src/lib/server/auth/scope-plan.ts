export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const OIDC_SCOPES = ['openid', 'email', 'profile'] as const;

export const AUTH_SCOPES = [...OIDC_SCOPES, GMAIL_READONLY_SCOPE] as const;
