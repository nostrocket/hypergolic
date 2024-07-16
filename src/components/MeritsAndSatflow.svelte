<script lang="ts">
	import * as Card from '@/components/ui/card';
	import Pie from './Pie.svelte';
	import * as Table from '@/components/ui/table';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';

	export let rocket: NDKEvent;
</script>

<Card.Root class="sm:col-span-3">
	<Card.Header class="pb-3">
		<Card.Title>Merits and Satflow</Card.Title>
		<Card.Description class="grid grid-cols-2">
			<div class=" grid-cols-1">
				This graph displays the Meritization of equity in {rocket.getMatchingTags('d')[0][1]}
				<Pie />
			</div>
			<div class=" grid-cols-1">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Participant</Table.Head>
							<Table.Head class="hidden md:table-cell">Merits</Table.Head>
							<Table.Head class="text-right">Sats Received</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						<Table.Row class=" bg-red-800">
							<Table.Cell>
								<div class="font-medium">Liam Johnson</div>
								<div class="hidden text-sm text-muted-foreground md:inline">liam@example.com</div>
							</Table.Cell>
							<Table.Cell class="hidden md:table-cell">17%</Table.Cell>
							<Table.Cell class="text-right">250k</Table.Cell>
						</Table.Row>
					</Table.Body>
				</Table.Root>
			</div>
		</Card.Description>
	</Card.Header>
	<Card.Footer></Card.Footer>
</Card.Root>
