<script lang="ts">
	import { AMRAuction, Rocket } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import { onDestroy } from 'svelte';
	import { derived, type Readable } from 'svelte/store';

	let saleEvents = $ndk.storeSubscribe([{ kinds: [1412 as number] }], {
		subId: 'all_sale_requests'
	});
	onDestroy(() => {
		saleEvents?.unsubscribe();
	});

	export let rockets: Readable<Rocket[]>;

	let validAuctionRequests = derived([saleEvents, rockets], ([$saleEvents, $rockets]) => {
		let provisional = new Map<string, AMRAuction>();
		let valid = new Map<string, AMRAuction>();
		for (let e of $saleEvents) {
			let a = new AMRAuction(undefined, e);

			if (a.Validate()) {
				provisional.set(a.Event.id, a);
			}
		}
		if ($rockets.length > 0) {
			for (let [_, a] of provisional) {
				for (let r of $rockets) {
					if (r.Name() == a.RocketD && a.RocketP == r.Event.pubkey) {
						if (a.ValidateAgainstRocket(r)) {
							a.Extra = { rocket: r };
							valid.set(a.Event.id, a);
						}
					}
				}
			}
		} else {
			valid = provisional;
		}
		return valid;
	});
	validAuctionRequests.subscribe((requests) => {
		if ($rockets && $rockets.length > 0 && currentUser && $currentUser) {
			for (let [_, r] of requests) {
                if (r.Extra.rocket.VotePowerForPubkey($currentUser.pubkey)) {
                    let e = r.Extra.rocket.UpsertAMRAuction(r)
                if (e) {
                    e.ndk = $ndk
                    e.publish().then(x=>{
                        console.log(x, e)
                    })
                }
                }
			}
		}
		//todo: validate and publish rocket updates
	});
</script>

<!-- {#each $validAuctionRequests as [_, a]}<span on:click={()=>{console.log(a)}}>{a.Event.id}</span>{/each} -->
