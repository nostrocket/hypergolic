<script lang="ts">
	export let title: string | undefined;
</script>

{#if title}
	<div class="my-4 flex items-center">
		<h1 class="scroll-m-20 text-xl font-semibold tracking-tight md:text-3xl">
			{title}
		</h1>
	</div>
{/if}
