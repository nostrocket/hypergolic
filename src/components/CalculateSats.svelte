<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { getCuckPrice } from '@/helpers';
	import { CalculatorSolid } from 'svelte-awesome-icons';

	const dispatch = createEventDispatcher();

	let hourly_rate: string = '';
	let spent_minutes: string = '';

	let cuckPrice: number | undefined = undefined;

	let open = false;

	$: calcSats = cuckPrice
		? (((parseFloat(hourly_rate) * 100000000) / cuckPrice) * parseFloat(spent_minutes)) / 60
		: undefined;

	$: if (!cuckPrice) {
		getCuckPrice().then((data) => {
			if (data instanceof Error) {
				console.error(data);
			} else {
				cuckPrice = data;
			}
		});
	}

	function sendResult() {
		if (calcSats) {
			dispatch('result', calcSats.toFixed(0));
			open = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Trigger class={buttonVariants({ variant: 'default', size: 'icon' })}
		><CalculatorSolid /></Dialog.Trigger
	>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Calculate the sats</Dialog.Title>
			<Dialog.Description
				>Calculate the sats of the request according to your hour rate.</Dialog.Description
			>
		</Dialog.Header>
		<Label for="hourly_rate">Hour rate</Label>
		<Input bind:value={hourly_rate} id="hourly_rate" placeholder="? USD / hour" />
		<Label for="spent_minutes">Working hours</Label>
		<Input bind:value={spent_minutes} id="spent_minutes" placeholder="? minutes" />
		{#if calcSats}
			<div>Result: {calcSats.toFixed(0)} sats</div>
		{/if}
		<Button disabled={!calcSats} on:click={sendResult}>OK</Button>
	</Dialog.Content>
</Dialog.Root>
