<script lang="ts">
	import type { AMRAuction, Rocket } from '@/event_helpers/rockets';
	import { Input } from '@/components/ui/input';
	import Button from '@/components/ui/button/button.svelte';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import validate from 'bitcoin-address-validation';

	export let amrAuction: AMRAuction | undefined;
	export let rocket: Rocket;
	export let selected_amrs: Map<string, AMRAuction>;

	let bitcoinAddress: string = '';
	$: bitcoinAddressInValid = true;
	$: bitcoinAddressError = '';

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
			selected_amrs = new Map<string, AMRAuction>();
			//goto(`${base}/rockets/${getRocketURL(e)}`);
		});
	}
</script>

{#if amrAuction}
	<div class="m-2 flex">
		You are selling {amrAuction.Merits} Merits
	</div>
	<div class="m-2 flex flex-col">
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
