export type GoogleRevokeResult = {
	attempted: boolean;
	revoked: boolean;
	status: number | null;
	error: string | null;
};

function sanitizeRevokeError(error: unknown): string {
	if (error instanceof Error && error.name) {
		return `request_failed:${error.name}`;
	}

	return 'request_failed:unknown';
}

export async function revokeGoogleAccess(params: {
	token: string | null | undefined;
	fetchImpl: typeof fetch;
}): Promise<GoogleRevokeResult> {
	const { token, fetchImpl } = params;

	if (!token) {
		return {
			attempted: false,
			revoked: false,
			status: null,
			error: 'missing_token'
		};
	}

	try {
		const response = await fetchImpl('https://oauth2.googleapis.com/revoke', {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({ token })
		});

		if (!response.ok) {
			return {
				attempted: true,
				revoked: false,
				status: response.status,
				error: `google_revoke_${response.status}`
			};
		}

		return {
			attempted: true,
			revoked: true,
			status: response.status,
			error: null
		};
	} catch (error) {
		return {
			attempted: true,
			revoked: false,
			status: null,
			error: sanitizeRevokeError(error)
		};
	}
}
