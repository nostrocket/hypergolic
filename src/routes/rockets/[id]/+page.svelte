<script>

	import { page } from "$app/stores";
    //flow: fetch all 31108's with this d-tag, sort by WoT, put Nostrocket Name Service one at the top. Dedupe same rocket (same state, shadows) from multiple users, just show them all as everyone agreeing.
    //second pass: fetch ignition event for each, rebuild current state and validate all proofs, compute votepower and display only the states with > 50%.

</script>
{$page.params.id}