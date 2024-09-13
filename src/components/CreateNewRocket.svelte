<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Alert from '@/components/ui/alert';
	import { Rocket, ZapRocketNamePurchase } from '@/event_helpers/rockets';
	import { getRocketURL } from '@/helpers';
	import { ndk } from '@/ndk';
	import { BitcoinTipTag } from '@/stores/bitcoin';
	import { currentUser, devmode, mainnet } from '@/stores/session';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import type NDKSvelte from '@nostr-dev-kit/ndk-svelte';
	import { Info } from 'lucide-svelte';
	import { onDestroy } from 'svelte';
	import { derived } from 'svelte/store';
	import { BUY_ROCKET_NAME_ZAPPED_PUBKEY, BUY_ROCKET_NAME_ZAPPED_EVENT } from '@/consts';
	import Login from './Login.svelte';

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

	onDestroy(() => {
		rocketEvents?.unsubscribe();
		zaps?.unsubscribe();
	});

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

	let userHasProfile = false;
	$: {
		if (!userHasProfile && $currentUser) {
			$currentUser.fetchProfile().then((r) => {
				if (r && (r.lud06 || r.lud16) && (r.name || r.displayName) && r.image) {
					userHasProfile = true;
				}
			});
		}
		userHasProfile = userHasProfile;
	}

	let name: string = '';

	$: nameValid = true;
	$: nameError = '';
	$: canPublish = true;

	const rocketNameValidator = /^\w{4,20}$/;

	$: isPurchasedByOthers =
		$purchasedRocketNames.all.includes(name) && !$purchasedRocketNames.my.includes(name);
	$: isPurchasedByMe = $purchasedRocketNames.my.includes(name);
	$: isPublished = $rockets.some((r) => r.Name() === name);

	$: {
		if (!name) {
			nameValid = false;
			nameError = '';
		} else if (name === 'NOSTROCKET' || (isPublished && (isPurchasedByMe || isPurchasedByOthers))) {
			nameValid = false;
			nameError = 'Please use another name';
		} else if (!rocketNameValidator.test(name)) {
			nameValid = false;
			nameError = 'Rocket name MUST be 4-20 alphanumeric characters';
		} else if (isPurchasedByOthers) {
			nameValid = false;
			nameError = 'Rocket name is already in use by someone else; you cannot use it';
		} else if (isPurchasedByMe && isPublished) {
			nameValid = false;
		} else {
			nameValid = true;
			nameError = '';
		}
	}

	$: {
		if (nameValid) {
			if (isPurchasedByMe && !isPublished) {
				canPublish = true;
			} else if (!$mainnet) {
				if (isPurchasedByMe && isPublished) {
					canPublish = false;
				} else if (isPurchasedByOthers) {
					canPublish = false;
				} else {
					canPublish = true;
				}
			} else {
				canPublish = false;
			}
		} else {
			canPublish = false;
		}
	}

	function publish(ndk: NDKSvelte, name: string) {
		if (!ndk.signer) {
			throw new Error('no ndk signer found');
		}
		let e = new NDKEvent(ndk);
		let author = $currentUser;
		if (!author) {
			throw new Error('no current user');
		}
		if (!nameValid) {
			throw new Error('name is invalid');
		}
		e.author = author;
		e.kind = 31108;
		e.created_at = Math.floor(new Date().getTime() / 1000);
		e.tags.push(['d', name]);
		e.tags.push(['ruleset', '334000']);
		e.tags.push(['ignition', 'this']);
		e.tags.push(['parent', 'this']);
		e.tags.push(BitcoinTipTag());
		e.publish().then((x) => {
			console.log(x);
			goto(`${base}/rockets/${getRocketURL(e)}`);
		});
	}
</script>

<Dialog.Root>
	<Dialog.Trigger class={`${buttonVariants({ variant: 'default' })} w-full`}
		>Create a Rocket</Dialog.Trigger
	>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Header>
			<Dialog.Title>Name Your Rocket</Dialog.Title>
			<Dialog.Description
				>Choose a name for your new Rocket and click Publish.
				<Alert.Root
					><Info class="h-4 w-4" /><Alert.Title>Heads up!</Alert.Title><Alert.Description
						>You are early, you can only create testnet rockets right now.</Alert.Description
					></Alert.Root
				></Dialog.Description
			>
		</Dialog.Header>
		<div class="grid gap-4 py-4">
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="name" class="text-right">Name</Label>
				<Input bind:value={name} id="name" placeholder="Name-of-your-rocket" class="col-span-3" />
			</div>
		</div>
		<div class="m-0 p-0 text-sm text-red-500">{nameError}</div>
		{#if $devmode}
			<div>Purchased My Rocket Name: {$purchasedRocketNames.my.join(', ')}</div>
			<div>Purchased All Rocket Name: {$purchasedRocketNames.all.join(', ')}</div>
			<div>isPurchasedByOthers: {isPurchasedByOthers}</div>
			<div>isPurchasedByMe: {isPurchasedByMe}</div>
			<div>isPublished: {isPublished}</div>
			<Button
				variant="outline"
				on:click={() => {
					console.log($validZaps);
				}}>Print Zaps</Button
			>
		{/if}
		<Dialog.Footer>
			{#if $currentUser}
				<Button
					disabled={!canPublish}
					on:click={() => {
						publish($ndk, name);
					}}
					type="submit">Publish</Button
				>
			{:else}
				<Login />
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
