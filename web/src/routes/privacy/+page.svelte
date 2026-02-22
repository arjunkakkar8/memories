<script lang="ts">
	import Card from '$lib/components/ui/Card.svelte';
</script>

<svelte:head>
	<title>Privacy and Google Access | Memories</title>
</svelte:head>

<main class="min-h-screen py-[clamp(1.25rem,3.8vw,2.75rem)]">
	<div class="mx-auto w-full max-w-[1080px] px-5 sm:px-6">
		<Card className="grid gap-4 p-[clamp(1.1rem,3vw,2rem)]" elevated={true}>
			<p class="text-[0.72rem] font-bold tracking-[0.13em] text-bloom-700 uppercase">Privacy</p>
			<h1>How Memories handles Google access</h1>

			<p>
				Memories requests the minimum scope set needed for story generation at sign-in: identity
				scopes plus
				<code>gmail.readonly</code>.
			</p>

			<section aria-labelledby="readonly-scope">
				<h2 id="readonly-scope">Readonly email access</h2>
				<p>
					<code>gmail.readonly</code> lets Memories read message content to generate stories, but never
					modify, send, or delete email.
				</p>
			</section>

			<section aria-labelledby="scope-boundary">
				<h2 id="scope-boundary">No broader Gmail permissions</h2>
				<p>
					Memories does not request compose, send, modify, or delete scopes. Access is limited to
					readonly email data plus identity information.
				</p>
			</section>

			<section aria-labelledby="storage-policy">
				<h2 id="storage-policy">No email content storage</h2>
				<p>
					Memories processes email content live for the requested action and does not store full
					email bodies at rest on our servers.
				</p>
			</section>
		</Card>
	</div>
</main>
