<script lang="ts">
	type Props = {
		label?: string;
		className?: string;
	};

	let { label = 'Loading', className = '' }: Props = $props();

	const dotClass =
		'h-2 w-2 animate-bounce rounded-full bg-bloom-soft [animation-duration:0.9s] [animation-timing-function:ease-in-out] [animation-iteration-count:infinite]';
</script>

<p
	class={`m-0 inline-flex items-center gap-[0.32rem] ${className}`}
	role="status"
	aria-live="polite"
	aria-label={label}
>
	<span class={dotClass}></span>
	<span class={`${dotClass} [animation-delay:120ms]`}></span>
	<span class={`${dotClass} [animation-delay:240ms]`}></span>
</p>
