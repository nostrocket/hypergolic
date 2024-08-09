<script lang="ts">
	import type { AMRAuction, Rocket } from '@/event_helpers/rockets';
	import { Input } from '@/components/ui/input';
	import Button from '@/components/ui/button/button.svelte';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import ExclamationTriangle from 'svelte-radix/ExclamationTriangle.svelte';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import validate from 'bitcoin-address-validation';

	export let amrAuction: AMRAuction | undefined;
	export let rocket: Rocket;
	export let selected_amrs: AMRAuction | undefined;

	let bitcoinAddress: string = '';
	$: bitcoinAddressInValid = true;
	$: bitcoinAddressError = '';
	$: isTestRocket = rocket.Name().toLowerCase().includes('test');

	$: if (bitcoinAddress) {
		if (!validate(bitcoinAddress)) {
			bitcoinAddressInValid = true;
			bitcoinAddressError = 'Bitcoin address is invalid';
		} else {
			bitcoinAddressInValid = false;
			bitcoinAddressError = '';
		}
	}

	function publish(amr: AMRAuction, rocket: Rocket) {
		if (!$ndk.signer) {
			throw new Error('no ndk signer found');
		}

		let author = $currentUser;
		if (!author) {
			throw new Error('no current user');
		}
		if (bitcoinAddressInValid) {
			throw new Error('Bitcoin address is invalid');
		}
		amr.RxAddress = bitcoinAddress;
		if (!amr.Validate()) {
			throw new Error('invalid');
		}
		if (!amr.ValidateAgainstRocket(rocket)) {
			throw new Error('invalid against rocket');
		}
		let e = amr.GenerateEvent();
		e.ndk = $ndk;
		e.author = author;
		console.log('AMRAuction', e);
		e.publish().then((x) => {
			console.log(x, e);
			selected_amrs = undefined;
			//goto(`${base}/rockets/${getRocketURL(e)}`);
		});
	}
</script>

{#if amrAuction}
	<div class="m-2 flex">
		You are selling {amrAuction.Merits} Merits
	</div>
	<div class="m-2 flex flex-col">
		{#if isTestRocket}
			<Alert.Root variant="destructive">
				<ExclamationTriangle class="h-4 w-4" />
				<Alert.Title>Warning</Alert.Title>
				<Alert.Description
					>Please do not enter a real Bitcoin address, as this is a test rocket.</Alert.Description
				>
			</Alert.Root>
		{/if}
		<div class="flex">
			<Input
				bind:value={bitcoinAddress}
				type="text"
				placeholder="Bitcoin Address for Payment"
				class="m-1 max-w-xs"
			/>
			<Button
				on:click={() => {
					publish(amrAuction, rocket);
				}}
				class="m-1">Sell Now</Button
			>
		</div>
		{#if bitcoinAddressError}
			<div class="ml-4 p-0 text-sm text-red-500">{bitcoinAddressError}</div>
		{/if}
	</div>
{/if}
