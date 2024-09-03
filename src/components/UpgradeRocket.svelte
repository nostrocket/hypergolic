<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { currentUser, devmode } from '@/stores/session';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import Login from './Login.svelte';
	import { BUY_ROCKET_NAME_ZAPPED_PUBKEY, BUY_ROCKET_NAME_ZAPPED_EVENT } from '@/consts';
	import { ndk } from '@/ndk';
	import { onDestroy } from 'svelte';
	import { derived } from 'svelte/store';
	import { Rocket, ZapRocketNamePurchase } from '@/event_helpers/rockets';
	import PayRocketName from './PayRocketName.svelte';

	export let rocketEvent: NDKEvent;

	let rocketEvents = $ndk.storeSubscribe([{ kinds: [31108 as number] }], { subId: 'rockets' });
	let zaps = $ndk.storeSubscribe(
		[
			{
				'#a': [`31108:${BUY_ROCKET_NAME_ZAPPED_PUBKEY}:${BUY_ROCKET_NAME_ZAPPED_EVENT}`],
				kinds: [9735]
			}
		],
		{
			subId: BUY_ROCKET_NAME_ZAPPED_EVENT + '_zaps'
		}
	);

	const rockets = derived(rocketEvents, ($rocketEvents) => {
		return $rocketEvents.map((e) => new Rocket(e));
	});

	let nostrocket = derived(rockets, ($rockets) => {
		let rocket: Rocket | undefined = undefined;
		for (let r of $rockets) {
			if (
				r.Name() == BUY_ROCKET_NAME_ZAPPED_EVENT &&
				r.Event.pubkey == BUY_ROCKET_NAME_ZAPPED_PUBKEY
			) {
				rocket = r;
			}
		}
		return rocket;
	});

	onDestroy(() => {
		rocketEvents?.unsubscribe();
		zaps?.unsubscribe();
	});

	let validZaps = derived(zaps, ($zaps) => {
		let zapMap = new Map<string, ZapRocketNamePurchase>();
		for (let z of $zaps) {
			let zapRocketNamePurchase = new ZapRocketNamePurchase(z);
			if (zapRocketNamePurchase.Valid()) {
				zapMap.set(zapRocketNamePurchase.ZapReceipt.id, zapRocketNamePurchase);
			}
		}
		return zapMap;
	});

	let purchasedRocketNames = derived(validZaps, ($validZaps) => {
		let my = [];
		let all = [];
		for (let z of $validZaps.values()) {
			if (z.RocketName) {
				all.push(z.RocketName);
				if ($currentUser?.pubkey === z.BuyerPubkey) {
					my.push(z.RocketName);
				}
			}
		}
		return { my, all };
	});

	let open = false;
	$: rocket = new Rocket(rocketEvent);

	$: isTestnetRocket = () => {
		if ($purchasedRocketNames.all.includes(rocket.Name())) {
			return false;
		} else if (rocket.Name() === 'NOSTROCKET') {
			return false;
		} else {
			return true;
		}
	};

	$: isRocketCreater = () => {
		if ($currentUser?.pubkey === rocket.Creator()) {
			return true;
		} else {
			return false;
		}
	};
</script>

{#if $devmode}
	<div>{`isTestnetRocket(): ${isTestnetRocket()}`}</div>
	<div>{`isRocketCreater(): ${isRocketCreater()}`}</div>
{/if}
{#if isTestnetRocket() && isRocketCreater()}
	<Dialog.Root bind:open>
		<Dialog.Trigger class={buttonVariants({ variant: 'default' })}>Upgrade rocket</Dialog.Trigger>
		<Dialog.Content class="sm:max-w-[425px]">
			<Dialog.Header>
				<Dialog.Title>Upgrade rocket</Dialog.Title>
				<Dialog.Description>Make a payment to upgrade the rocket to the mainnet.</Dialog.Description
				>
			</Dialog.Header>
			<Dialog.Footer>
				{#if $currentUser}
					{#if $nostrocket}
						<PayRocketName disabled={false} rocketName={rocket.Name()} nostrocket={$nostrocket} />
					{/if}
				{:else}
					<Login />
				{/if}
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{/if}
