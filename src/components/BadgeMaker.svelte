<script lang="ts">
	import { Badge } from '@/components/ui/badge';

	export let left = false;
	export let right = false;
</script>

<div class="m-1 flex flex-nowrap items-stretch {left ? 'mr-auto' : ''} {right ? 'ml-auto' : ''}">
	<Badge variant="nostr" class="mr-0 rounded-none p-0"><slot name="icon" /></Badge><Badge
		variant="outline"
		class="rounded-none"
	>
		<div class="flex items-center gap-2">
			<slot name="content" />
		</div>
	</Badge>
</div>
