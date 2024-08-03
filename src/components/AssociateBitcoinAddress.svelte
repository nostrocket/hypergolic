<script lang="ts">
	import * as Card from "@/components/ui/card";


	import Heading from "./Heading.svelte";
	import InputBitcoinAddress from "./InputBitcoinAddress.svelte";
	import { Button } from "@/components/ui/button";
	import { ndk } from "@/ndk";
	import { currentUser } from "@/stores/session";
	import { NDKEvent } from "@nostr-dev-kit/ndk";
	import validate from "bitcoin-address-validation";

    let bitcoinAddress:string;

	function publish(address:string) {
		if (!$ndk.signer) {
			throw new Error('no ndk signer found');
		}
		let author = $currentUser;
		if (!author) {
			throw new Error('no current user');
		}
        if (!validate(address)) {
            throw new Error("invalid bitcoin address")
        }
        let event = new NDKEvent($ndk)
        event.kind = 1413
        event.tags.push(["onchain", address])
		//todo: let user specify a rocket
		console.log("todo: let user specify a rocket")
		event.publish().then((x) => {
			console.log(x);
		}).catch(()=>{ console.log("failed to publish", event.rawEvent())});
	}

</script>
<Heading title="Sponsor a Contributor" />
<Card.Root>
	<Card.Header><Card.Title>Associate Bitcoin Address</Card.Title></Card.Header>
	<Card.Content>
	<div class="m-2 flex">
		You must associate at least one Bitcoin address with your npub before you can pay a Contributor. Merit purchases from this address will be associated with your pubkey.
	</div>
	<div class="flex"><InputBitcoinAddress bind:bitcoinAddress /><Button on:click={()=>publish(bitcoinAddress)} class="mt-3 max-w-xs">Publish</Button></div>
</Card.Content>
</Card.Root>