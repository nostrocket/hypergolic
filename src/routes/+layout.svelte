<script lang="ts">
	import { ModeWatcher } from 'mode-watcher';
	import '../app.css';
	import SidePanelLayout from '../layouts/SidePanelLayout.svelte';
	import { ndk } from '@/ndk';
	import type { NDKUser } from '@nostr-dev-kit/ndk';
	import { currentUser, prepareUserSession } from '@/stores/session';
	import { unixTimeNow } from '@/helpers';
	import { getBitcoinTip } from '@/stores/bitcoin';

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

	let lastRequestTime = 0;

	$: {
		if (unixTimeNow() > lastRequestTime + 30000) {
			getBitcoinTip().then((x) => {
				if (x) {
					lastRequestTime = unixTimeNow();
				}
			});
		}
	}
</script>

<ModeWatcher defaultMode="dark" />
<SidePanelLayout>
	<div slot="content"><slot></slot></div>
</SidePanelLayout>

<style></style>
