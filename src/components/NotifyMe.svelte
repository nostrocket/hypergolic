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
	import { TelegramBrand } from 'svelte-awesome-icons';

	let email: string = '';
	let fax: string = '';
	$: emailInValid = true;
	$: emailError = 'Email is invalid';
	const emailRegex = /^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/;

	$: {
		emailError = emailRegex.test(email) ? '' : 'Email is invalid';
	}
	$: {
		emailInValid = emailRegex.test(email) ? false : true;
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
			u r so early
		</Badge>
	</Dialog.Trigger>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Subscribe for Updates</Dialog.Title>
			<Dialog.Description>
				Nostrocket is under active development, many things are broken. Subscribe now and we'll ping
				you when there are new releases and new features.
			</Dialog.Description>
			<div class="flex flex-col gap-4 py-4">
				{#if $currentUser}
					<Button on:click={Subscribe}>DM me with updates</Button>
				{:else}
					<Login />
				{/if}
				<Separator />
				<span class="ml-auto mr-auto flex"
					>If you don't use nostr, that's SAD! Whatever, I guess we can fax you or email you or
					something</span
				>
				<div class="grid grid-cols-4 items-center gap-4">
					<Label for="email" class="text-right">Email</Label>
					<Input bind:value={email} id="email" placeholder="Your email" class="col-span-3" />
				</div>
				<!-- {#if emailError}
					<div class="ml-4 p-0 text-sm text-red-500">{emailError}</div>
				{/if} -->
				<div class="grid grid-cols-4 items-center gap-4">
					<Label for="fax" class="text-right">Fax number</Label>
					<Input bind:value={fax} id="email" placeholder="Your fax number" class="col-span-3" />
				</div>
				{#if fax.length > 0}
					<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1" allow="autoplay"
					></iframe>
				{/if}
			</div>
			<Button disabled={emailInValid} on:click={SubmitEmailAndSubscribe}
				>{emailError ? emailError : 'Please email me with updates'}</Button
			>
			<Separator />
			<a href="https://t.me/nostrocket" class="flex flex-nowrap">
				<TelegramBrand class="mr-2" /> Join the Telegram Group
			</a>
		</Dialog.Header>
	</Dialog.Content>
</Dialog.Root>
