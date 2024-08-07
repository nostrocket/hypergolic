<script lang="ts">
	import * as Card from '@/components/ui/card';
	import * as Table from '@/components/ui/table';
	import { Rocket } from '@/event_helpers/rockets';
	import { writable } from 'svelte/store';
	import Pie from './Pie.svelte';
	import { Avatar, Name } from '@nostr-dev-kit/ndk-svelte-components';
	import { ndk } from '@/ndk';

	export let rocket: Rocket;
	export let unratifiedZaps: Map<string, number>;

	let unratifiedZapsAmount = 0;

	$: {
		unratifiedZapsAmount = 0;
		for (let [_, a] of unratifiedZaps) {
			unratifiedZapsAmount += a / 1000;
		}
		unratifiedZapsAmount = unratifiedZapsAmount;
	}
	let _merits: { pubkey: string; merits: number; sats: number }[] = [];

	let merits = writable(_merits);

	$: {
		let m = new Map<string, { merits: number; sats: number }>();
		for (let [_, amr] of rocket.ApprovedMeritRequests()) {
			let existing = m.get(amr.Pubkey);
			if (!existing) {
				existing = { merits: 0, sats: 0 };
			}
			existing.merits += amr.Merits;
			existing.sats += amr.SatsOwed();
			m.set(amr.Pubkey, existing);
		}

		//calculate percentage ownership of each pubkey and divide the unratified sats among them (round up to nearest sat):
		let satsPerMeritPercentage = unratifiedZapsAmount / 100;
		let totalMerits = rocket.TotalMerits();
		for (let [id, _m] of m) {
			_m.sats += (_m.merits / totalMerits) * 100 * satsPerMeritPercentage;
			_m.sats = Math.round(_m.sats);
			m.set(id, _m);
		}

		let _merits: { pubkey: string; merits: number; sats: number }[] = [];
		for (let [pubkey, _m] of m) {
			_merits.push({ pubkey: pubkey, merits: _m.merits, sats: _m.sats });
		}
		if (_merits.length == 0) {
			_merits.push({ pubkey: rocket.Event.pubkey, merits: 1, sats: 0 });
		}

		merits.set(_merits);
	}

	const COLORS = [
		'bg-rose-500',
		'bg-pink-500',
		'bg-teal-500',
		'bg-orange-500',
		'bg-purple-500',
		'bg-sky-500',
		'bg-green-500',
		'bg-yellow-500',
		'bg-zinc-500',
		'bg-light-500'
	];

	function c(i: number) {
		return COLORS[i];
	}
</script>

<Card.Root class="sm:col-span-3">
	<Card.Header class="pb-3">
		<Card.Title>Merits and Satflow</Card.Title>
		<Card.Description class="grid grid-cols-2">
			<div class=" grid-cols-1">
				This graph displays the Meritization of equity in {rocket.Name()}
				<Pie data={$merits} />
			</div>
			<div class=" grid-cols-1">
				<Table.Root>
					<Table.Header>
						<Table.Row class="">
							<Table.Head>Participant</Table.Head>
							<Table.Head class="hidden md:table-cell">Merits</Table.Head>
							<Table.Head class="text-right">Revenue (Sats)</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each $merits as { pubkey, merits, sats }, i (pubkey)}
							<Table.Row class="{c(i)} hover:{c(i)}">
								<Table.Cell>
									<div class="flex flex-nowrap">
										<Avatar
											ndk={$ndk}
											{pubkey}
											class="h-8 w-8 flex-none rounded-full object-cover"
										/>
										<Name
											ndk={$ndk}
											{pubkey}
											class="hidden max-w-32 truncate p-1 md:inline-block"
										/>
									</div>
								</Table.Cell>
								<Table.Cell class="hidden md:table-cell">{merits}</Table.Cell>
								<Table.Cell class="text-right">{sats}</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
		</Card.Description>
	</Card.Header>
	<Card.Footer></Card.Footer>
</Card.Root>
