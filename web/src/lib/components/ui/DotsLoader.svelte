<script lang="ts">
	import { slide } from 'svelte/transition';

	type Props = {
		textSnippets?: string[];
		label?: string;
	};

	let { textSnippets = [], label = 'Loading' }: Props = $props();
	let activeSnippetIndex = $state(0);

	const activeLabel = $derived(
		textSnippets.length > 0 ? textSnippets[activeSnippetIndex % textSnippets.length] : label
	);

	$effect(() => {
		if (textSnippets.length <= 1) {
			activeSnippetIndex = 0;
			return;
		}

		const intervalId = setInterval(() => {
			activeSnippetIndex = (activeSnippetIndex + 1) % textSnippets.length;
		}, 2000);

		return () => {
			clearInterval(intervalId);
		};
	});

	const dotClass =
		'h-2 w-2 animate-bounce rounded-full bg-bloom-soft [animation-duration:0.9s] [animation-timing-function:ease-in-out] [animation-iteration-count:infinite]';
</script>

<div class="flex items-center gap-2 w-full justify-center">
	{#key activeLabel}
		<p class="whitespace-nowrap text-bloom-soft" in:slide={{ duration: 300, axis: 'x' }}>
			{activeLabel}
		</p>
	{/key}
	<p
		class="m-0 inline-flex items-center gap-[0.32rem]"
		role="status"
		aria-live="polite"
		aria-label={activeLabel || textSnippets[0]}
	>
		<span class={dotClass}></span>
		<span class={`${dotClass} [animation-delay:120ms]`}></span>
		<span class={`${dotClass} [animation-delay:240ms]`}></span>
	</p>
</div>
