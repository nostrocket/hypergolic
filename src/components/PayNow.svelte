<script lang="ts">
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Alert from '@/components/ui/alert';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import { NDKEvent, NDKZap } from '@nostr-dev-kit/ndk';
	import { Terminal } from 'lucide-svelte';
	import Todo from './Todo.svelte';
	import { requestProvider } from 'webln';

    export let product:NDKEvent;
    export let rocket:NDKEvent;

    function zap() {
        let z = new NDKZap({ndk:$ndk, zappedEvent:rocket, zappedUser: rocket.author})
        z.createZapRequest(1000, `Purchase of ${product.getMatchingTags("name")[0][1]} from ${rocket.dTag}`, [["product", product.id]]).then(invoice=>{
            if (invoice) {
                requestProvider().then((webln)=>{
                    webln.sendPayment(invoice).then((response)=>{
                        if (response && response.preimage) {
                            console.log(response.preimage)
							open = false;
                        }
                    })
                });
            }
        })
    }

let open:boolean;
</script>

<Dialog.Root bind:open={open}>
	<Dialog.Trigger class={buttonVariants({ variant: 'default' })}>Buy Now</Dialog.Trigger>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Header>
			<Dialog.Title
				>Buy {product.getMatchingTags('name')[0][1]} from {rocket.dTag} now!</Dialog.Title
			>
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
		<Todo text={['generate zap request and get invoice']} />

		<Dialog.Footer>
			<a href="#" on:click={zap}>test</a>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
