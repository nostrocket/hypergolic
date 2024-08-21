<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Alert from '@/components/ui/alert';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import { Terminal } from 'lucide-svelte';
	import Todo from './Todo.svelte';
	import { Product, Rocket } from '@/event_helpers/rockets';

	export let product: Product;
	export let rocket: Rocket;

	let price: number = 0;
	let max: number = 0;
	let validAfter: number = 0;

	let o = false;

	function publish() {
		if (!$ndk.signer) {
			throw new Error('no ndk signer found');
		}
		let author = $currentUser;
		if (!author) {
			throw new Error('no current user');
		}
		if (rocket.Event.author.pubkey != author.pubkey) {
			throw new Error(`${author.pubkey} is not the creator of this rocket`);
		}
		console.log(37, validAfter);
		let event = rocket.UpsertProduct(product.ID(), price, max, validAfter);
		event.ndk = $ndk;
		event
			.publish()
			.then((x) => {
				console.log(x);
				o = false;
			})
			.catch(() => {
				console.log('failed to publish', event.rawEvent());
			});
	}
</script>

<Dialog.Root bind:open={o}>
	<Dialog.Trigger class={buttonVariants({ variant: 'default' })}
		>Make Available for Purchase</Dialog.Trigger
	>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Header>
			<Dialog.Title>Make this product available to customers</Dialog.Title>
			{#if !currentUser}
				<Alert.Root>
					<Terminal class="h-4 w-4" />
					<Alert.Title>Heads up!</Alert.Title>
					<Alert.Description
						>You need a nostr signing extension to use Nostrocket!</Alert.Description
					>
				</Alert.Root>
			{/if}
			<Dialog.Description>Choose a name for your new Rocket and click Publish</Dialog.Description>
		</Dialog.Header>
		<div class="grid gap-4 py-4">
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="price" class="text-right">Price</Label>
				<Input bind:value={price} id="price" placeholder="Price in sats" class="col-span-3" />
			</div>
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="max" class="text-right">Max Available</Label>
				<Input
					bind:value={max}
					id="max"
					placeholder="Maximum number that can be sold"
					class="col-span-3"
				/>
			</div>
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="validAfter" class="text-right">Valid After</Label>
				<Input
					bind:value={validAfter}
					id="validAfter"
					placeholder="Cannot be purchased before this time (unix)"
					class="col-span-3"
				/>
			</div>
		</div>
		<Todo text={['validate input is a number']} />
		<Dialog.Footer>
			<Button
				on:click={() => {
					publish();
				}}
				type="submit">Publish</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
