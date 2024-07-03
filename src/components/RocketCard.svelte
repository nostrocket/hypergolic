<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import type { NDKEvent } from '@nostr-dev-kit/ndk';

	export let rocketEvent: NDKEvent;
    //$page.url.searchParams.get("tab")
    function getRocketURL(e:NDKEvent):string {

        let ignitionID = undefined;
        if (e.getMatchingTags('ignition') && e.getMatchingTags('ignition')[0] && e.getMatchingTags('ignition')[0][1]) {
            ignitionID = e.getMatchingTags('ignition')[0][1]
        }
        if (!ignitionID) {
            ignitionID = e.id
        }
        let d = e.getMatchingTags('d')[0][1]
        let p = e.pubkey
        return `${ignitionID}?d=${d}&p=${p}`
    }
</script>

<Card.Root class="w-[350px]">
	<Card.Header>
		<Card.Title>{rocketEvent.getMatchingTags('d')[0][1]}</Card.Title>
		<Card.Description>{rocketEvent.getMatchingTags('mission')[0][1]}</Card.Description>
	</Card.Header>
	<Card.Content></Card.Content>
	<Card.Footer class="flex justify-between">
        <Button on:click={()=>{console.log(rocketEvent.rawEvent())}} variant="outline">Print to Console</Button>
		<Button on:click={()=>{goto(`${base}/rockets/${getRocketURL(rocketEvent)}`)}}>View Full Rocket</Button>
	</Card.Footer>
</Card.Root>
