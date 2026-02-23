import type { ScanSampledWindow } from './types';

type SampleRandomWindowsOptions = {
	now?: Date;
	count: number;
	durationDaysOptions: number[];
	maxLookbackDays: number;
	maxOverlapRatio?: number;
	randomFn?: () => number;
};

function overlapRatio(left: ScanSampledWindow, right: ScanSampledWindow): number {
	const overlapStart = Math.max(left.startEpochSec, right.startEpochSec);
	const overlapEnd = Math.min(left.endEpochSec, right.endEpochSec);
	const overlapSeconds = Math.max(0, overlapEnd - overlapStart);
	if (overlapSeconds <= 0) {
		return 0;
	}

	const leftDuration = left.endEpochSec - left.startEpochSec;
	const rightDuration = right.endEpochSec - right.startEpochSec;
	const baseDuration = Math.max(1, Math.min(leftDuration, rightDuration));

	return overlapSeconds / baseDuration;
}

function clampDurationDays(durationDaysOptions: number[]): number[] {
	return durationDaysOptions
		.map((value) => Math.floor(value))
		.filter((value) => Number.isFinite(value) && value > 0);
}

export function sampleRandomWindows(options: SampleRandomWindowsOptions): ScanSampledWindow[] {
	const {
		now = new Date(),
		count,
		durationDaysOptions,
		maxLookbackDays,
		maxOverlapRatio,
		randomFn = Math.random
	} = options;

	if (count <= 0) {
		return [];
	}

	const normalizedDurations = clampDurationDays(durationDaysOptions);
	if (normalizedDurations.length === 0) {
		return [];
	}

	const nowEpochSec = Math.floor(now.getTime() / 1000);
	const lookbackSeconds = Math.max(1, Math.floor(maxLookbackDays * 24 * 60 * 60));
	const earliestStart = nowEpochSec - lookbackSeconds;
	const windows: ScanSampledWindow[] = [];
	const maxAttempts = Math.max(20, count * 50);

	for (let attempt = 0; attempt < maxAttempts && windows.length < count; attempt += 1) {
		const durationDays =
			normalizedDurations[Math.floor(randomFn() * normalizedDurations.length)] ??
			normalizedDurations[0];
		const durationSeconds = durationDays * 24 * 60 * 60;
		const latestStart = nowEpochSec - durationSeconds;

		if (latestStart <= earliestStart) {
			continue;
		}

		const startEpochSec =
			earliestStart + Math.floor(randomFn() * Math.max(1, latestStart - earliestStart));
		const candidate: ScanSampledWindow = {
			id: `window-${windows.length + 1}`,
			startEpochSec,
			endEpochSec: startEpochSec + durationSeconds,
			durationDays
		};

		if (
			typeof maxOverlapRatio === 'number' &&
			windows.some((window) => overlapRatio(window, candidate) > maxOverlapRatio)
		) {
			continue;
		}

		windows.push(candidate);
	}

	return windows;
}
