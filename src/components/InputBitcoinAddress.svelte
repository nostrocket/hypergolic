<script lang="ts">
	import { Input } from '@/components/ui/input';
	import validate from 'bitcoin-address-validation';

	export let bitcoinAddress: string;
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
</script>

<div class="m-2 flex flex-col">
	<div class="flex">
		<Input
			bind:value={bitcoinAddress}
			type="text"
			placeholder="Bitcoin Address for Payment"
			class="m-1 max-w-xs"
		/>
	</div>
	{#if bitcoinAddressError}
		<div class="ml-4 p-0 text-sm text-red-500">{bitcoinAddressError}</div>
	{/if}
</div>
