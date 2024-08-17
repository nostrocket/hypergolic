<script lang="ts">
	import { onMount } from 'svelte';
	import { expoInOut } from 'svelte/easing';
	import { tweened } from 'svelte/motion';

	export let targetValue: number;

	let currentValue = tweened(0, { duration: 3000, easing: expoInOut });

	// Re-trigger animation whenever targetValue changes
	$: if (targetValue !== undefined && targetValue !== null) {
		currentValue.set(targetValue);
	}

	onMount(() => {
		currentValue.set(targetValue);
	});
</script>

<span class="merits">{Math.floor($currentValue).toLocaleString()}</span>
