<script lang="ts">
	import { ndk } from '$lib/ndk';
	import { Button } from '@/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Avatar } from '@nostr-dev-kit/ndk-svelte-components';
	import { NDKNip07Signer } from '@nostr-dev-kit/ndk';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';

	onMount(() => {
		if (localStorage.getItem('signed-in')) {
			nip07();
		}
	});
	$: pubkey = '';

	async function nip07() {
		document.body.appendChild(document.createElement('script')).src =
			'https://unpkg.com/window.nostr.js/dist/window.nostr.js';

		try {
			const signer = new NDKNip07Signer();
			const user = await signer.blockUntilReady();

			if (user) {
				pubkey = user.pubkey;
				$ndk.signer = signer;
				$ndk = $ndk;
				localStorage.setItem('signed-in', 'true');
			}
		} catch (e) {
			alert(e);
		}
	}
</script>

{#if !$ndk.signer}
	<Button on:click={nip07} class="shrink-0">Sign in</Button>
{:else}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger asChild let:builder>
			<Button builders={[builder]} variant="secondary" size="icon" class="shrink-0 rounded-full">
				<Avatar ndk={$ndk} {pubkey} class="h-10 w-10 flex-none rounded-full object-cover" />
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
			<DropdownMenu.Item on:click={() => {
				goto(`${base}/buymerits`);
			}}>Buy Merits</DropdownMenu.Item>
			<DropdownMenu.Separator />
			<DropdownMenu.Item>Settings</DropdownMenu.Item>
			<DropdownMenu.Item>Support</DropdownMenu.Item>
			<DropdownMenu.Separator />
			<DropdownMenu.Item>Logout</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}
