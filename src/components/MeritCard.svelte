<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import type { MeritRequest } from '@/event_helpers/merits';
	import { ndk } from '@/ndk';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';

	export let merit:MeritRequest;
	export let rocket:NDKEvent;
</script>


	<Card.Root class="m-2">
		<Card.Header>
			<Card.Title>{merit.Problem()}</Card.Title>
			<Card.Description>
				<div class="flex flex-nowrap">
					<Avatar
						ndk={$ndk}
						pubkey={merit.Pubkey}
						class="h-10 w-10 flex-none rounded-full object-cover"
					/>
					<Name
						ndk={$ndk}
						pubkey={merit.Pubkey}
						class="hidden max-w-32 truncate p-2 md:inline-block"
					/>
				</div>
			</Card.Description>
		</Card.Header>
		<Card.Content></Card.Content>
		<Card.Footer class="flex justify-between">
			VOTE YES VOTE NO
		</Card.Footer>
	</Card.Root>

