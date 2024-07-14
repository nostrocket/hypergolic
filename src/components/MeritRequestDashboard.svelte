<script lang="ts">
	import { base } from '$app/paths';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb/index.js';
	import type { MeritRequest } from '@/event_helpers/merits';
	import { getRocketURL } from '@/helpers';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';
	import MeritCard from './MeritCard.svelte';

	export let rocket: NDKEvent;
	export let merit: MeritRequest;
</script>

<div class="flex flex-col sm:gap-4">
	<header class="flex items-center">
		<Breadcrumb.Root class="flex">
			<Breadcrumb.List>
				<Breadcrumb.Item>
					<Breadcrumb.Link href={`${base}/rockets/${getRocketURL(rocket)}`}
						>{rocket.getMatchingTags('d')[0][1]}</Breadcrumb.Link
					>
				</Breadcrumb.Item>
				<Breadcrumb.Separator />
				<Breadcrumb.Item>
					<Breadcrumb.Link href={`${base}/rockets/${getRocketURL(rocket)}`}>Merit Requests</Breadcrumb.Link>
				</Breadcrumb.Item>
				<Breadcrumb.Separator />
				<Breadcrumb.Item>
					<Breadcrumb.Page>{merit.Problem()}</Breadcrumb.Page>
				</Breadcrumb.Item>
			</Breadcrumb.List>
		</Breadcrumb.Root>
	</header>
	<main
		class="grid flex-1 items-start gap-4 p-4 sm:px-6 sm:py-0 md:gap-2 lg:grid-cols-3 xl:grid-cols-3"
	>
	<MeritCard {rocket} {merit} />
</main>
</div>
