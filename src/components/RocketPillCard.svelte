<script>
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/stores';
	import { Button } from '@/components/ui/button';
	import * as Card from '@/components/ui/card';
</script>
{#if $page.route.id != "/"}
<Card.Root>
	<Card.Header class="pt-0 p-4">
		<Card.Title>WTF</Card.Title>
		<Card.Description>I'm new to Nostrocket, wtf is this thing all about?</Card.Description>
	</Card.Header>
	<Card.Content class="pt-0 md:p-4">
		<Button on:click={()=>{goto(`${base}/`)}} size="sm" class="w-full">Rocketpill Me</Button>
	</Card.Content>
</Card.Root>
{/if}