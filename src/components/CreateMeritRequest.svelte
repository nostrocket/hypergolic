<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Alert from '@/components/ui/alert';
	import Textarea from '@/components/ui/textarea/textarea.svelte';
	import { getRocketURL } from '@/helpers';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import type NDKSvelte from '@nostr-dev-kit/ndk-svelte';
	import { Terminal } from 'lucide-svelte';
	import Todo from './Todo.svelte';
	import { Checkbox } from '@/components/ui/checkbox';

	export let rocketEvent: NDKEvent;

	let problem: string;
	let solution: string;
	let image: string;
	let merits: number = 0;
	let sats: number = 0;
	let wts = false;
	let minimum:number = 0;

	$: {
		if (wts && minimum == 0) {
			minimum = sats
		}
	}

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
		e.kind = 1409;
		e.created_at = Math.floor(new Date().getTime() / 1000);
		e.tags.push(['problem', 'text', problem]);
		e.tags.push(['solution', 'url', solution]);
		e.tags.push(['a', `31108:${rocketEvent.pubkey}:${rocketEvent.dTag}`]);
		e.tags.push(['merits', sats.toString(10)]);
		e.tags.push(['sats', sats.toString(10)]);
		console.log(e.rawEvent());
		e.publish().then((x) => {
			console.log(x);
			goto(`${base}/rockets/${getRocketURL(e)}`);
		});
	}
</script>

<Dialog.Root>
	<Dialog.Trigger class={buttonVariants({ variant: 'default' })}
		>Create a Merit Request</Dialog.Trigger
	>
	<Dialog.Content class="sm:max-w-[425px]">
		{#if !currentUser}
			<Alert.Root>
				<Terminal class="h-4 w-4" />
				<Alert.Title>Heads up!</Alert.Title>
				<Alert.Description>You need a nostr signing extension to use Nostrocket!</Alert.Description>
			</Alert.Root>
		{/if}
		<Dialog.Header>
			<Dialog.Title>Request Merits</Dialog.Title>
			<Dialog.Description>Request Merits for your work</Dialog.Description>
		</Dialog.Header>
		<div class="grid gap-4 py-4">
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="name" class="text-right">Problem</Label>
				<Textarea
					bind:value={problem}
					id="name"
					placeholder="Describe the problem you solved, links to github are also acceptable"
					class="col-span-3"
				/>
			</div>
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="desc" class="text-right">Solution</Label>
				<Textarea
					bind:value={solution}
					id="desc"
					placeholder="Link to your solution (e.g. a merged PR or some other evidence)"
					class="col-span-3"
				/>
			</div>
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="sats" class="text-right">Sats</Label>
				<Input
					bind:value={sats}
					id="price"
					placeholder="Number of Merits you are requesting"
					class="col-span-3"
				/>
			</div>
			<div class="grid items-center gap-4">
				<span>You are requesting {sats} Merits</span>
			</div>

			<div class="flex items-center space-x-2">
				<Checkbox id="sell" bind:checked={wts} aria-labelledby="terms-label" />
				<Label
					id="terms-label"
					for="sell"
					class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
				>
					I want Sats not Merits
				</Label>
			</div>

			{#if wts}
			If your Merit Request is approved, it will be auctioned to potential sponsors. You can set a minimum amount below which your Approved Merit Request will not be sold.

			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="sats" class="text-right col-span-2">Minimum Price (Sats)</Label>
				<Input
					bind:value={minimum}
					id="price"
					placeholder="Number of Merits you are requesting"
					class="col-span-2"
				/>
			</div>
			
			{/if}

		</div>
		<Dialog.Footer>
			<Button
				on:click={() => {
					publish($ndk);
				}}
				type="submit">Publish</Button
			>

		</Dialog.Footer>
		<Todo
		text={['validate sane field entries', 'Sats must be number', 'highlight errors somehow']}
	/>
	</Dialog.Content>
</Dialog.Root>
