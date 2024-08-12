<script lang="ts">
	import { BitcoinAssociation, Rocket } from '@/event_helpers/rockets';
	import { ndk } from '@/ndk';
	import { currentUser } from '@/stores/session';
	import { onDestroy } from 'svelte';
	import { derived, type Readable } from 'svelte/store';

	let associations = $ndk.storeSubscribe([{ kinds: [1413 as number] }], {
		subId: 'all_association_requests'
	});
	onDestroy(() => {
		associations?.unsubscribe();
	});

	export let rockets: Readable<Rocket[]>;

	let validAssociationRequests = derived(
		[associations, rockets],
		([$associationEvents, $rockets]) => {
			let valid = new Map<string, BitcoinAssociation>();
			for (let e of $associationEvents) {
				let a = new BitcoinAssociation(e);
				if (a.Validate()) {
					valid.set(a.Event.id, a);
				}
			}
			return valid;
		}
	);

	let validAgainstMyRocket = derived(
		[currentUser, validAssociationRequests, rockets],
		([$currentUser, $associationRequests, $rockets]) => {
			let valid: { rocket: Rocket; association: BitcoinAssociation }[] = [];
			if ($currentUser) {
				if ($rockets.length > 0) {
					for (let [_, a] of $associationRequests) {
						for (let r of $rockets) {
							if (r.VotePowerForPubkey($currentUser.pubkey)) {
								if (!r.BitcoinAssociations().get(a.Pubkey)) {
									//todo: get current list of Bitcoin associations, if (this is not included)
									valid.push({ rocket: r, association: a });
								}
							}
						}
					}
				}
			}
			return valid;
		}
	);

	validAgainstMyRocket.subscribe((requests) => {
		if ($rockets && $rockets.length > 0 && currentUser && $currentUser) {
			for (let { rocket, association } of requests) {
				if (
					rocket.VotePowerForPubkey($currentUser.pubkey) &&
					!rocket.Included(association.Event.id)
				) {
					for (let a of association.Event.getMatchingTags('a')) {
						if (a.length == 2 && a[1] == rocket.ATag()[1]) {
							let e = rocket.UpsertBitcoinAssociation(association);
							if (e) {
								e.ndk = $ndk;
								e.publish().then((x) => {
									console.log(x, e);
								});
							}
						}
					}
				}
			}
		}
	});
</script>
