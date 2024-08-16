<script lang="ts">
	import { onMount } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { tweened } from 'svelte/motion';

	export let targetValue: number;

	let currentValue = tweened(0, { duration: 1000, easing: cubicOut });

	// Re-trigger animation whenever targetValue changes
	$: if (targetValue !== undefined && targetValue !== null) {
		currentValue.set(targetValue);
	}

	onMount(() => {
		currentValue.set(targetValue);
	});
</script>

<span class="merits">{$currentValue.toFixed(0)}</span>

<style>
	.merits {
		transition:
			transform 0.5s ease-in-out,
			opacity 0.5s ease-in-out;
	}
</style>
