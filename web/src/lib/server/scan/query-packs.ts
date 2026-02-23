import type { ScanSampledWindow } from './types';

export type ScanQueryPack = {
	id: string;
	name: string;
	query: string;
	labelIds?: string[];
};

const QUERY_PACKS: Record<string, ScanQueryPack> = {
	'inbox-focus': {
		id: 'inbox-focus',
		name: 'Inbox Focus',
		query: 'in:inbox -category:promotions -category:social -category:updates'
	},
	'starred-important': {
		id: 'starred-important',
		name: 'Starred and Important',
		query: 'is:starred OR is:important'
	},
	'sent-replies': {
		id: 'sent-replies',
		name: 'Sent With Replies',
		query: 'in:sent -in:chats'
	}
};

export function resolveQueryPacks(packIds: string[]): ScanQueryPack[] {
	const resolved: ScanQueryPack[] = [];

	for (const packId of packIds) {
		const pack = QUERY_PACKS[packId];
		if (pack) {
			resolved.push(pack);
		}
	}

	return resolved;
}

export function createCustomQueryPack(query: string): ScanQueryPack {
	return {
		id: 'custom',
		name: 'Custom Query',
		query
	};
}

export function materializeGmailQuery(pack: ScanQueryPack, window: ScanSampledWindow): string {
	const fragments = [
		pack.query.trim(),
		`after:${window.startEpochSec}`,
		`before:${window.endEpochSec}`
	];
	return fragments.filter(Boolean).join(' ');
}
