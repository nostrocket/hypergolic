<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Alert from '@/components/ui/alert';
	import { Checkbox } from '@/components/ui/checkbox';
	import Textarea from '@/components/ui/textarea/textarea.svelte';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import type NDKSvelte from '@nostr-dev-kit/ndk-svelte';
	import { Terminal } from 'lucide-svelte';
	import Todo from './Todo.svelte';

	export let rocketEvent: NDKEvent;

	let problem: string = '';
	let solution: string = '';
	let merits: number = 0;
	let sats: string = '';
	let wts = false;
	let minimum: string = '';
	let _minimum_from_sats = false;

	let last_sale_price = 1 / 1;

	let num = /^\d+$/;

	let open = false;

	$: {
		if (!num.test(sats)) {
			sats = '';
		}
		if (!num.test(minimum)) {
			minimum = '';
		}
		merits = parseInt(sats, 10) * last_sale_price;
	}

	$: {
		if (wts && minimum == '' && !_minimum_from_sats) {
			_minimum_from_sats = true;
			minimum = sats;
		}
	}

	function isValidUrl(string:string):boolean {
		try {
			new URL(string);
			return true;
		} catch (err) {
			return false;
		}
	}

	function validateSolution(solution:string) {
		if (solution.length > 0) {
			return isValidUrl(solution)
		}
		return true
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
		if (solution.length > 0) {
			e.tags.push(['solution', 'url', solution]);
		}
		e.tags.push(['a', `31108:${rocketEvent.pubkey}:${rocketEvent.dTag}`]);
		e.tags.push(['merits', merits.toString(10)]);
		e.tags.push(['sats', sats]);
		console.log(e.rawEvent());
		e.publish().then((x) => {
			console.log(x);
			open = false
			//goto(`${base}/rockets/${getRocketURL(e)}`);
		});
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Trigger class={buttonVariants({ variant: 'default' })}
		>Create a Merit Request</Dialog.Trigger
	>
	<Dialog.Content class="sm:max-w-[625px]">
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
					class="col-span-3 {problem.length < 10 ? 'border-red-600' : 'border-green-700'}"
				/>
			</div>
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="desc" class="text-right">Solution</Label>
				<Textarea
					bind:value={solution}
					id="desc"
					placeholder="Link to your solution (e.g. a merged PR or some other evidence)"
					class="col-span-3 {validateSolution(solution)? 'border-green-700':'border-red-600'}"
				/>
			</div>
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="sats" class="text-right">Value of your work (Sats)</Label>
				<Input bind:value={sats} id="price" placeholder="Sats" class="col-span-1 {parseInt(sats, 10) > 0?'border-green-700':'border-red-600'}" />
				{#if parseInt(sats, 10) > 0}<Label class="text-left">({merits.toString()} Merits)</Label>
				{/if}
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
				Your Merits will be auctioned to potential sponsors as soon as it is approved, enabling you
				to be paid in Sats for your work. Tip: you don't have to decide right now, you can do this
				at any time.

				<div class="grid grid-cols-4 items-center gap-4">
					<Label for="sats" class="col-span-2 text-right">Auction Reserve Price (Sats)</Label>
					<Input bind:value={minimum} id="price" placeholder="Reserve Price" class="col-span-1" />
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
			text={['remove white border on focus so that the validation indication color can be seen']}
		/>
	</Dialog.Content>
</Dialog.Root>
