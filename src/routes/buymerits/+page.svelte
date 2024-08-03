<script lang="ts">
	import { currentUser } from '@/stores/session';
	import Login from '../../components/Login.svelte';
	import { ndk } from '@/ndk';
	import { onDestroy } from 'svelte';
	import { derived } from 'svelte/store';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import { type RocketAMR, AMRAuction, Rocket } from '@/event_helpers/rockets';
	import * as Table from '@/components/ui/table';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { Checkbox } from '@/components/ui/checkbox';
	import Button from '@/components/ui/button/button.svelte';
	import { Input } from '@/components/ui/input';
	let rocketEvents = $ndk.storeSubscribe([{ kinds: [31108 as number] }], { subId: 'all_rockets' });
	onDestroy(() => {
		rocketEvents?.unsubscribe();
	});

	let rockets = derived(rocketEvents, ($rocketEvents) => {
		let m = new Map<string, NDKEvent>();
		for (let e of $rocketEvents) {
			let existing = m.get(e.pubkey + e.dTag);
			if (!existing) {
				existing = e;
			}
			if (e.created_at > existing) {
				existing = e;
			}
			m.set(e.pubkey + e.dTag, e);
		}
		return Array.from(m, ([_, e]) => e);
	});

	let myMeritRequests = derived([currentUser, rockets], ([$currentUser, $rockets]) => {
		let merits = new Map<Rocket, RocketAMR[]>();
		if ($currentUser) {
			for (let r of $rockets) {
				let parsedRocket = new Rocket(r);
				let _merits: RocketAMR[] = [];
				for (let [_, amr] of parsedRocket.ApprovedMeritRequests()) {
					if (amr.Pubkey == $currentUser.pubkey) {
						_merits.push(amr);
					}
				}
				merits.set(parsedRocket, _merits);
			}
		}
		return merits;
	});

	let selected = new Map<string, AMRAuction>();
	function toggleSelected(amr: RocketAMR, rocket: Rocket) {
		if (selected.has(amr.ID)) {
			selected.delete(amr.ID);
		} else {
			selected.set(amr.ID, new AMRAuction(amr, rocket.Event));
		}
		selected = selected;
	}

    function getTotal(list:Map<string, AMRAuction>):number {
        let total = 0
        for (let [_, amr] of list) {
            total += amr.Merits
        }
        return total
    }

	function getAllForRocket(rocket:Rocket, selected:Map<string, AMRAuction>):Map<string, AMRAuction> {
        let thisRocket = new Map<string, AMRAuction>()
        for (let [_, amr] of selected) {
            if (amr.RocketD == rocket.Name() && amr.RocketP == rocket.Event.author.pubkey) {
                thisRocket.set(amr.AMRID, amr)
            }
        }
		return thisRocket
    }

	function publish(sales:Map<string, AMRAuction>, address: string, rocket:Rocket) {
		if (!$ndk.signer) {
			throw new Error('no ndk signer found');
		}
		let e = new NDKEvent($ndk);
		let author = $currentUser;
		if (!author) {
			throw new Error('no current user');
		}


		e.author = author;
		e.kind = 1412;
		e.created_at = Math.floor(new Date().getTime() / 1000);
		for (let [_, amr] of sales) {
			e.tags.push(["request", amr.AMRID])
		}

		e.tags.push(['a', `31108:${rocket.Event.pubkey}:${rocket.Event.dTag}`]);
		//todo: allow user to set start and end auction price
		let total = getTotal(getAllForRocket(rocket, sales)).toString()
		e.tags.push(['price', total + ":" + total]);
		e.tags.push(["onchain", address])
		e.publish().then((x) => {
			console.log(x, e);

			//goto(`${base}/rockets/${getRocketURL(e)}`);
		});
	}

	let bitcoinAddress:string = ""
</script>

<h1 class=" m-2 text-nowrap text-center text-xl">Trade your Merits for Sats</h1>

{#if $currentUser}
	{#each $myMeritRequests as [rocket, amr]}
		{#if amr.length > 0}
			<h1>ROCKET: {rocket.Name()}</h1>

			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="w-[100px]">Selected</Table.Head>
						<Table.Head class="w-[10px]">AMR</Table.Head>
						<Table.Head class="w-[10px]">Eligible</Table.Head>
						<Table.Head>Merits</Table.Head>
						<Table.Head class="text-right">Sats (approx)</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each amr as a, id (a.ID)}
						<Table.Row class={selected.has(a.ID) ? 'bg-orange-500 hover:bg-orange-500' : ''}>
							<Table.Cell
								><Checkbox
									id={a.ID}
									checked={selected.has(a.ID)}
									on:click={() => {
										toggleSelected(a, rocket);
									}}
								/></Table.Cell
							>
							<Table.Cell
								><span
									class="cursor-pointer font-medium underline"
									on:click={() => {
										goto(`${base}/rockets/merits/${a.ID}`);
									}}>{a.ID.substring(0, 6)}</span
								></Table.Cell
							>
							<Table.Cell>{a.LeadTime == 0}</Table.Cell>
							<Table.Cell>{a.Merits}</Table.Cell>
							<Table.Cell class="text-right">{a.Merits}</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
			{#if selected.size > 0}
            <div class="m-2 flex">You are selling {getTotal(getAllForRocket(rocket, selected))} Merits</div>
				<div class="m-2 flex">
					<Input bind:value={bitcoinAddress} type="text" placeholder="Bitcoin Address for Payment" class="m-1 max-w-xs" />
					<Button on:click={()=>{publish(getAllForRocket(rocket, selected), bitcoinAddress, rocket)}} class="m-1">Sell Now</Button>
				</div>
			{/if}
		{/if}
	{/each}
{:else}<Login />{/if}
