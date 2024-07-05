<script lang="ts">
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

    let name:string;

	function publish(ndk: NDKSvelte, name: string) {
		if (!ndk.signer) {
			throw new Error('no ndk signer found');
		}
		let e = new NDKEvent(ndk);
		let author = $currentUser;
		if (!author) {
			throw new Error('no current user');
		}
        e.author = author;
        e.kind = 31108;
        e.created_at = Math.floor(new Date().getTime() / 1000);
        //todo validate d tag
        e.tags.push(["d", name])
        e.tags.push(["ruleset", "334000"])
        e.publish().then((x)=>{
            console.log(x)
            goto(`${base}/rockets/${getRocketURL(e)}`)
        })
	}
</script>

<Dialog.Root>
	<Dialog.Trigger class={buttonVariants({ variant: 'default' })}>Create a Rocket</Dialog.Trigger>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Header>
			<Dialog.Title>Name Your Rocket</Dialog.Title>
			{#if !currentUser}
				<Alert.Root>
					<Terminal class="h-4 w-4" />
					<Alert.Title>Heads up!</Alert.Title>
					<Alert.Description
						>You need a nostr signing extension to use Nostrocket!</Alert.Description
					>
				</Alert.Root>
			{/if}
			<Dialog.Description>Choose a name for your new Rocket and click Publish</Dialog.Description>
		</Dialog.Header>
		<div class="grid gap-4 py-4">
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="name" class="text-right">Name</Label>
				<Input bind:value={name} id="name" placeholder="Name-of-your-rocket" class="col-span-3" />
			</div>
		</div>
		<Todo text={['validate input is a valid d tag (NIP01)']} />
		<Dialog.Footer>
			<Button on:click={()=>{publish($ndk, name)}} type="submit">Publish</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
