<script lang="ts">
	import { ModeWatcher } from 'mode-watcher';
	import '../app.css';
	import SidePanelLayout from '../layouts/SidePanelLayout.svelte';
	import { ndk } from '@/ndk';
	import type { NDKUser } from '@nostr-dev-kit/ndk';
	import { currentUser, prepareUserSession } from '@/stores/session';

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
</script>

<ModeWatcher defaultMode="dark" />
<SidePanelLayout>
	<div slot="content"><slot></slot></div>
</SidePanelLayout>

<style></style>
