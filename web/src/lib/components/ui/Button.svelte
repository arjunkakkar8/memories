<script lang="ts">
	type ButtonVariant = 'primary' | 'secondary' | 'ghost';
	type ButtonSize = 'sm' | 'md';

	type Props = {
		variant?: ButtonVariant;
		size?: ButtonSize;
		type?: 'button' | 'submit' | 'reset';
		disabled?: boolean;
		href?: string | null;
		className?: string;
		onclick?: () => void;
		children: import('svelte').Snippet;
	};

	let {
		variant = 'primary',
		size = 'md',
		type = 'button',
		disabled = false,
		href = null,
		className = '',
		onclick,
		children
	}: Props = $props();

	const baseClass =
		'inline-flex cursor-pointer items-center justify-center gap-[0.45rem] rounded-full font-[650] tracking-[0.01em] no-underline transition-[transform,box-shadow,background-color] duration-150 hover:-translate-y-px disabled:pointer-events-none disabled:translate-y-0 disabled:cursor-wait disabled:opacity-[0.62] aria-disabled:pointer-events-none aria-disabled:translate-y-0 aria-disabled:cursor-wait aria-disabled:opacity-[0.62]';

	const variantClass = $derived(
		variant === 'primary'
			? 'border border-bloom-border-strong bg-linear-to-br from-clay-700 to-bloom-700 text-white shadow-button-primary'
			: variant === 'secondary'
				? 'border border-ink-border-secondary bg-paper-secondary text-ink-900'
				: 'border border-ink-border-ghost bg-transparent text-ink-900'
	);

	const sizeClass = $derived(
		size === 'sm'
			? 'px-[0.8rem] py-[0.48rem] text-[0.84rem]'
			: 'px-[1.05rem] py-[0.68rem] text-[0.94rem]'
	);
</script>

{#if href}
	<a
		href={disabled ? undefined : href}
		class={`${baseClass} ${variantClass} ${sizeClass} ${className}`}
		aria-disabled={disabled}
		{onclick}
	>
		{@render children()}
	</a>
{:else}
	<button
		{type}
		class={`${baseClass} ${variantClass} ${sizeClass} ${className}`}
		{disabled}
		{onclick}
	>
		{@render children()}
	</button>
{/if}
