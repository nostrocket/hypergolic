<script lang="ts">
	import * as Breadcrumb from '$lib/components/ui/breadcrumb/index.js';
	import * as Card from '@/components/ui/card';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import CreateMeritRequest from './CreateMeritRequest.svelte';
	import CreateNewProduct from './CreateNewProduct.svelte';
	import MeritsAndSatflow from './MeritsAndSatflow.svelte';
	import ProductFomo from './ProductFomo.svelte';
	import ProposedProducts from './ProposedProducts.svelte';
	import Todo from './Todo.svelte';
	import MeritRequests from './MeritRequests.svelte';
	import Button from '@/components/ui/button/button.svelte';

	export let rocket: NDKEvent;
</script>

<div class="flex flex-col sm:gap-4">
	<header class="flex items-center">
		<Breadcrumb.Root class="flex">
			<Breadcrumb.List>
				<Breadcrumb.Item>
					<Breadcrumb.Link href="##">{rocket.getMatchingTags('d')[0][1]}</Breadcrumb.Link>
				</Breadcrumb.Item>
				<Breadcrumb.Separator />
				<Breadcrumb.Item>
					<Breadcrumb.Page>Dashboard</Breadcrumb.Page>
				</Breadcrumb.Item>
			</Breadcrumb.List>
		</Breadcrumb.Root>
	</header>
	<main
		class="grid flex-1 items-start gap-4 p-4 sm:px-6 sm:py-0 md:gap-2 lg:grid-cols-3 xl:grid-cols-3"
	>
		<MeritsAndSatflow {rocket} />

		<ProductFomo {rocket} />

		<ProposedProducts {rocket} />

		<MeritRequests {rocket} />
		<Card.Root class="sm:col-span-3">
			<Card.Header class="pb-3">
				<Card.Title>Actions</Card.Title>
				<Card.Description class="flex space-x-4">
					<CreateNewProduct rocketEvent={rocket} />
					<CreateMeritRequest rocketEvent={rocket} />
					<Button on:click={()=>{console.log(rocket.rawEvent())}}>Print to Console</Button>
				</Card.Description>
			</Card.Header>
			<Card.Footer></Card.Footer>
		</Card.Root>

		<Todo
			text={[
				'delete rocket (if current user is rocket creator)',
				'modify relevant data and republish event according to https://github.com/nostrocket/NIPS/blob/main/31108.md and https://github.com/nostrocket/NIPS/blob/main/MSBR334000.md '
			]}
		/>
	</main>
</div>
