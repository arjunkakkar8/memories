<svelte:head>
	<title>Privacy and Google Access | Memories</title>
</svelte:head>

<main>
	<h1>How Memories handles Google access</h1>

	<p>
		Memories requests the minimum scope set needed for story generation at sign-in: identity scopes plus
		<code>gmail.readonly</code>.
	</p>

	<section aria-labelledby="readonly-scope">
		<h2 id="readonly-scope">Readonly email access</h2>
		<p>
			<code>gmail.readonly</code> lets Memories read message content to generate stories, but never modify,
			send, or delete email.
		</p>
	</section>

	<section aria-labelledby="scope-boundary">
		<h2 id="scope-boundary">No broader Gmail permissions</h2>
		<p>
			Memories does not request compose, send, modify, or delete scopes. Access is limited to readonly email
			data plus identity information.
		</p>
	</section>

	<section aria-labelledby="storage-policy">
		<h2 id="storage-policy">No email content storage</h2>
		<p>
			Memories processes email content live for the requested action and does not store full email bodies at
			rest on our servers.
		</p>
	</section>
</main>
