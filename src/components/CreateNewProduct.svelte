<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { ndk } from '@/ndk';
	import Todo from './Todo.svelte';
	import { currentUser } from '@/stores/session';
	import { Terminal } from 'lucide-svelte';
	import * as Alert from '@/components/ui/alert';
	import type NDKSvelte from '@nostr-dev-kit/ndk-svelte';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { getRocketURL } from '@/helpers';
	import Textarea from '@/components/ui/textarea/textarea.svelte';
	import UploadMediaLink from './UploadMediaLink.svelte';
	import type { BlobDescriptor } from 'blossom-client-sdk';

	export let rocketEvent: NDKEvent;

	let name: string;
	let desc: string;
	let image: string;

	let o = false;

	function publish(ndk: NDKSvelte) {
		if (!ndk.signer) {
			throw new Error('no ndk signer found');
		}
		let e = new NDKEvent(ndk);
		let author = $currentUser;
		if (!author) {
			throw new Error('no current user');
		}
		e.author = author;
		e.kind = 1908;
		e.created_at = Math.floor(new Date().getTime() / 1000);
		//todo validate d tag
		e.tags.push(['name', name]);
		e.tags.push(['description', desc]);
		e.tags.push(['cover', image]);
		e.tags.push(['a', `31108:${rocketEvent.pubkey}:${rocketEvent.dTag}`]);
		e.tags.push(['ruleset', '334000']);
		console.log(e.rawEvent());
		e.publish().then((x) => {
			console.log(x);
			o = false;
			goto(`${base}/rockets/${getRocketURL(rocketEvent)}`);
		});
	}

	function handleUploaded(event: CustomEvent<BlobDescriptor>) {
		image = event.detail.url;
	}
</script>

<Dialog.Root bind:open={o}>
	<Dialog.Trigger class={buttonVariants({ variant: 'default' })}
		>Propose a New Product</Dialog.Trigger
	>
	<Dialog.Content class="sm:max-w-[425px]">
		<Todo
			text={[
				'validate sane field entries',
				'name.length > 5 < 20',
				'description length > 20',
				'image url resolves and is image'
			]}
		/>
		{#if !currentUser}
			<Alert.Root>
				<Terminal class="h-4 w-4" />
				<Alert.Title>Heads up!</Alert.Title>
				<Alert.Description>You need a nostr signing extension to use Nostrocket!</Alert.Description>
			</Alert.Root>
		{/if}
		<Dialog.Header>
			<Dialog.Title>Publish a New Product</Dialog.Title>

			<Dialog.Description>Create a new product listing for your Rocket!</Dialog.Description>
		</Dialog.Header>
		<div class="grid gap-4 py-4">
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="name" class="text-right">Name</Label>
				<Input bind:value={name} id="name" placeholder="Product Name" class="col-span-3" />
			</div>
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="desc" class="text-right">Description</Label>
				<Textarea bind:value={desc} id="desc" placeholder="Description" class="col-span-3" />
			</div>
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="image" class="text-right">Cover Image</Label>
				<div class="col-span-3">
					<Input bind:value={image} id="name" placeholder="URL of cover image" />
					<UploadMediaLink on:uploaded={handleUploaded}>Upload</UploadMediaLink>
				</div>
			</div>
		</div>
		<Dialog.Footer>
			<Button
				on:click={() => {
					publish($ndk);
				}}
				type="submit">Publish</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
