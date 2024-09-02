<script lang="ts">
	import { ndk } from '$lib/ndk';
	import { Button } from '@/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Avatar } from '@nostr-dev-kit/ndk-svelte-components';
	import UseTemporaryAccount from './UseTemporaryAccount.svelte';
	import ConnectToBunker from './ConnectToBunker.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { NDKNip07Signer } from '@nostr-dev-kit/ndk';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { connectToBunker, loginWithNsec, purgeSignedInStorage } from '@/login';
	import { pubkey } from '@/stores/session';

	$: isLoading = true;

	onMount(async () => {
		const signedIn = localStorage.getItem('signed-in');
		if (signedIn) {
			try {
				if (signedIn === 'nip07') {
					await loginByExtension();
				} else if (signedIn === 'nsec') {
					const nsec = localStorage.getItem('signed-in-nsec');
					if (nsec) {
						const signer = loginWithNsec(nsec);
						if (signer instanceof Error) {
							purgeSignedInStorage();
						} else {
							$pubkey = (await signer.user()).pubkey;
							$ndk.signer = signer;
						}
					} else {
						purgeSignedInStorage();
					}
				} else if (signedIn === 'nip46') {
					const token = localStorage.getItem('signed-in-nsecbunker-token');
					if (token) {
						const signer = await connectToBunker(token);
						$pubkey = (await signer.user()).pubkey;
						$ndk.signer = signer;
					} else {
						purgeSignedInStorage();
					}
				} else {
					purgeSignedInStorage();
				}
			} catch (error) {
				console.error('Error during auto-login:', error);
				purgeSignedInStorage();
			}
		}
		isLoading = false;
	});

	async function loginByExtension() {
		try {
			const signer = new NDKNip07Signer();
			const user = await signer.blockUntilReady();

			if (user) {
				$pubkey = user.pubkey;
				$ndk.signer = signer;
				localStorage.setItem('signed-in', 'nip07');
			}
		} catch (e) {
			alert(e);
		}
	}

	async function logout() {
		purgeSignedInStorage();
		$ndk.signer = undefined;
		$pubkey = '';
		await goto(`${base}/`);
	}
</script>

{#if !$ndk.signer}
	<Dialog.Root>
		<Dialog.Trigger class="shrink-0">
			<Button disabled={isLoading}>
				{#if isLoading}
					Loading...
				{:else}
					Log In
				{/if}
			</Button>
		</Dialog.Trigger>
		<Dialog.Content class="flex flex-col gap-4 p-4">
			<Dialog.Header>
				<Dialog.Title>Log In</Dialog.Title>
			</Dialog.Header>
			<Button on:click={loginByExtension} class="w-full">Browser Extension</Button>
			<div class="w-full space-y-2">
				<UseTemporaryAccount />
				<ConnectToBunker />
			</div>
		</Dialog.Content>
	</Dialog.Root>
{:else}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger asChild let:builder>
			<Button builders={[builder]} variant="secondary" size="icon" class="shrink-0 rounded-full">
				<Avatar ndk={$ndk} pubkey={$pubkey} class="h-10 w-10 flex-none rounded-full object-cover" />
				<span class="sr-only">Toggle user menu</span>
			</Button>
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end">
			<DropdownMenu.Label>My Account</DropdownMenu.Label>
			<DropdownMenu.Separator />
			<DropdownMenu.Item
				on:click={() => {
					goto(`${base}/sellmerits`);
				}}>Sell Merits</DropdownMenu.Item
			>
			<DropdownMenu.Item
				on:click={() => {
					goto(`${base}/buymerits`);
				}}>Buy Merits</DropdownMenu.Item
			>
			<DropdownMenu.Separator />
			<DropdownMenu.Item>Settings</DropdownMenu.Item>
			<DropdownMenu.Item>Support</DropdownMenu.Item>
			<DropdownMenu.Separator />
			<DropdownMenu.Item on:click={logout}>Logout</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}
