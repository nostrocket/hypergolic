<script>
	import { RocketSolid } from 'svelte-awesome-icons';
	import '../app.css';
	import { ModeWatcher } from 'mode-watcher';
	import SidePanelLayout from '../layouts/SidePanelLayout.svelte';
</script>
<ModeWatcher />
<SidePanelLayout>
	<div slot="content"><slot></slot></div>
</SidePanelLayout>
<style></style>
