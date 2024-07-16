<script lang="ts">
	import Terminal from 'lucide-svelte/icons/terminal';
	import * as Alert from '$lib/components/ui/alert/index.js';
	export let text: string[];
</script>

<Alert.Root>
	<Terminal class="h-4 w-4" />
	<Alert.Title>Todo:</Alert.Title>
	<Alert.Description>
		{#if text.length > 1}
			<ul class="list-disc">
				{#each text as t}<li>{t}</li>{/each}
			</ul>
		{:else}
			{text}
		{/if}
	</Alert.Description>
</Alert.Root>
