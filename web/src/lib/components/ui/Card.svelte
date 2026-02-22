<script lang="ts">
	type Props = {
		elevated?: boolean;
		className?: string;
		children: import('svelte').Snippet;
	};

	let { elevated = false, className = '', children }: Props = $props();
	const shellClass = $derived(
		elevated
			? 'rounded-[1.25rem] border border-ink-border-elevated bg-linear-to-b from-paper-surface-top to-paper-surface-bottom shadow-card'
			: 'rounded-2xl border border-ink-border-soft bg-paper-surface shadow-soft backdrop-blur-[6px]'
	);
</script>

<section class={`${shellClass} ${className}`}>
	{@render children()}
</section>
