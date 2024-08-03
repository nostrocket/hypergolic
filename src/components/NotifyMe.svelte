<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Badge } from '@/components/ui/badge';

let open = false;
</script>

<Dialog.Root bind:open>
	<Dialog.Trigger
		><Badge href="#" variant="nostr" class="flex h-8 shrink-0 items-center justify-center rounded-sm">Nostrocket is sooooo not ready yet but whatever</Badge></Dialog.Trigger
	>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Nostrocket is a work in progress</Dialog.Title>
			<Dialog.Description
				>It kind of works, but there's a lot more to do. There will be bugs.</Dialog.Description
			>
		</Dialog.Header>

	</Dialog.Content>
</Dialog.Root>
