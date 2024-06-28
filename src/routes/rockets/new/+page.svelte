<script lang="ts">
	import { Input } from '$lib/components/ui/input/index.js';
	import { Button } from '@/components/ui/button';
	import { RocketState } from '@/types';
	import { NDKEvent } from '@nostr-dev-kit/ndk';
	import SidePanelLayout from '../../../layouts/SidePanelLayout.svelte';

    let rocketName:string;
    $:err = undefined;

    function validate() {
        let e = new NDKEvent()
        e.dTag = rocketName
        try {
            new RocketState(e)
        } catch(_err) {
            console.log(_err)
            err = _err
            return 
        }
        err = undefined
        console.log(new RocketState(e))
        
    }
    
</script>

<SidePanelLayout>
	<div slot="content">
        <div class="flex w-full max-w-sm flex-col gap-1.5">
            <Input type="email" id="email-2" placeholder="Name" bind:value={rocketName} />
            <p class="text-sm text-muted-foreground">Enter the name of your new Rocket</p>
            <Button on:click={validate} type="submit">Publish</Button>
            <div>{err?err:""}</div>
          </div>
	</div>
</SidePanelLayout>
