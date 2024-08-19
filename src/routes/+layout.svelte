<script lang="ts">
	import { ndk } from '@/ndk';
	import { getBitcoinTip } from '@/stores/bitcoin';
	import { currentUser, prepareUserSession } from '@/stores/session';
	import type { NDKUser } from '@nostr-dev-kit/ndk';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import '../app.css';
	import SidePanelLayout from '../layouts/SidePanelLayout.svelte';
	import { getCommitInfo } from '@/stores/github';

	let sessionStarted = false;
	let connected = false;
	let user: NDKUser | undefined;

	$ndk.connect(5000).then(() => {
		connected = true;
	});

	$: if (connected && !sessionStarted && $ndk.signer) {
		$ndk.signer.user().then((u) => {
			$currentUser = u;
			user = u;
			prepareUserSession($ndk, user).then(() => {
				sessionStarted = true;
			});
		});
		sessionStarted = true;
	}

	onMount(() => {
		getBitcoinTip();
		getCommitInfo(new URL('https://github.com/nostrocket/hypergolic/'));
	});

	setInterval(
		function () {
			getBitcoinTip();
		},
		2 * 60 * 1000
	);
</script>

<ModeWatcher defaultMode="dark" />
<SidePanelLayout>
	<div slot="content"><slot></slot></div>
</SidePanelLayout>
