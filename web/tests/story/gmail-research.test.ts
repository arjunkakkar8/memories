import { describe, expect, it, vi } from 'vitest';
import { fetchSelectedThread } from '../../src/lib/server/story/gmail-research';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json'
		}
	});
}

describe('fetchSelectedThread', () => {
	it('classifies metadata-scope full-format failures with stable reason code', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse(
				{
					error: {
						message: "Metadata scope doesn't allow format FULL",
						errors: [{ reason: 'forbidden' }]
					}
				},
				403
			)
		);

		await expect(
			fetchSelectedThread('thread-123', {
				accessToken: 'token',
				fetchImpl: fetchImpl as never
			})
		).rejects.toThrow('gmail_request_failed:403:threads.get:metadataScopeFullFormatForbidden');

		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('fails immediately for non-retryable forbidden reasons', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse(
				{
					error: {
						message: 'Access denied',
						errors: [{ reason: 'forbidden' }]
					}
				},
				403
			)
		);

		await expect(
			fetchSelectedThread('thread-123', {
				accessToken: 'token',
				fetchImpl: fetchImpl as never
			})
		).rejects.toThrow('gmail_request_failed:403:threads.get:forbidden');

		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
