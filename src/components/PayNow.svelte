<script lang="ts">
	import { Rocket } from 'lucide-svelte';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { ndk } from '@/ndk';
	import Todo from './Todo.svelte';
	import { currentUser } from '@/stores/session';
	import { Terminal } from 'lucide-svelte';
	import * as Alert from '@/components/ui/alert';
	import type NDKSvelte from '@nostr-dev-kit/ndk-svelte';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { getRocketURL } from '@/helpers';

    export let product:NDKEvent;
    export let rocket:NDKEvent;

   
</script>

<Dialog.Root>
	<Dialog.Trigger class={buttonVariants({ variant: 'default' })}>Buy Now</Dialog.Trigger>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Header>
			<Dialog.Title>Buy {product.getMatchingTags("name")[0][1]} from {rocket.dTag} now!</Dialog.Title>
			{#if !currentUser}
				<Alert.Root>
					<Terminal class="h-4 w-4" />
					<Alert.Title>Heads up!</Alert.Title>
					<Alert.Description
						>You need a nostr signing extension to use Nostrocket!</Alert.Description
					>
				</Alert.Root>
			{/if}
			<Dialog.Description>Pay now with Lightning</Dialog.Description>
		</Dialog.Header>
        <Todo text={["generate zap request and get invoice"]} />
		<Dialog.Footer>

		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
