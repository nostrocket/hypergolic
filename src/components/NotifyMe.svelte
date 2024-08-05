<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Badge } from '@/components/ui/badge';
	import Button from '@/components/ui/button/button.svelte';
	import Input from '@/components/ui/input/input.svelte';
	import Label from '@/components/ui/label/label.svelte';
	import Separator from '@/components/ui/separator/separator.svelte';
	import { ndk } from '@/ndk';
	import { prepareEncryptedDirectMessageEvent } from '@/helpers';
	import { currentUser } from '@/stores/session';
	import Login from './Login.svelte';
	import { NDKPrivateKeySigner, NDKUser } from '@nostr-dev-kit/ndk';

	let email: string;
	$: emailInValid = true;
	$: emailError = '';
	const emailRegex = /^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/;

	$: if (email) {
		if (!emailRegex.test(email)) {
			emailInValid = true;
			emailError = 'Email is invalid';
		} else {
			emailInValid = false;
			emailError = '';
		}
	}

	async function Subscribe() {
		const error = await publishEncryptedDirectMessage(
			`Please send me a direct message when Nostrocket updates. (Sent by Nostrocket)`
		);
		if (error instanceof Error) {
			console.error(error);
		}
		open = false;
	}

	async function SubmitEmailAndSubscribe() {
		const error = await publishEncryptedDirectMessage(
			`Please notify me via email when Nostrocket updates. My email address is ${email}. (Sent by Nostrocket)`
		);
		if (error instanceof Error) {
			console.error(error);
		}
		open = false;
	}

	async function publishEncryptedDirectMessage(content: string) {
		const RECEIVER = new NDKUser({
			pubkey: 'd91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075'
		});

		const originalSigner = $ndk.signer;
		if (!$currentUser) {
			$ndk.signer = NDKPrivateKeySigner.generate();
		}

		const event = await prepareEncryptedDirectMessageEvent({
			ndk: $ndk,
			receiver: RECEIVER,
			content
		});

		if (event instanceof Error) {
			return event;
		}

		const publishResult = await event.publish();
		console.log(publishResult);

		if (!$currentUser) {
			$ndk.signer = originalSigner;
		}
	}

	let open = false;
</script>

<Dialog.Root bind:open>
	<Dialog.Trigger>
		<Badge
			href="#"
			variant="nostr"
			class="flex h-8 shrink-0 items-center justify-center rounded-sm"
		>
			Tell me via DM when there are updates
		</Badge>
	</Dialog.Trigger>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Subscribe for Updates</Dialog.Title>
			<Dialog.Description>
				Receive notifications about Nostrocket updates via Nostr DM or email.
			</Dialog.Description>
			<div class="flex flex-col gap-4 py-4">
				{#if $currentUser}
					<Button on:click={Subscribe}>Reveive DM</Button>
				{:else}
					<Login />
				{/if}
				<Separator />
				<div class="grid grid-cols-4 items-center gap-4">
					<Label for="email" class="text-right">Email</Label>
					<Input bind:value={email} id="email" placeholder="Your email" class="col-span-3" />
				</div>
				{#if emailError}
					<div class="ml-4 p-0 text-sm text-red-500">{emailError}</div>
				{/if}
			</div>
			<Button disabled={emailInValid} on:click={SubmitEmailAndSubscribe}>Reveive Email</Button>
		</Dialog.Header>
	</Dialog.Content>
</Dialog.Root>
