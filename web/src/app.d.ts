// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { AuthSession, SessionUser } from '$lib/server/auth/session';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			session: AuthSession | null;
			user: SessionUser | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
