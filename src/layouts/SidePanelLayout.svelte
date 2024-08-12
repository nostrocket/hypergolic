<script lang="ts">
	import Menu from 'lucide-svelte/icons/menu';
	import Sun from 'svelte-radix/Sun.svelte';
	import Moon from 'svelte-radix/Moon.svelte';
	import { toggleMode } from 'mode-watcher';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import NewMenu from '../components/Menu.svelte';
	import RocketPillCard from '../components/RocketPillCard.svelte';
	import { base } from '$app/paths';
	import Login from '../components/Login.svelte';
	import { Badge } from '@/components/ui/badge';
	import { bitcoinTip } from '@/stores/bitcoin';
	import NotifyMe from '../components/NotifyMe.svelte';

	export let title = '';
</script>

<div class="grid min-h-screen w-full md:grid-cols-[220px_1fr] lg:grid-cols-[260px_1fr]">
	<div class="hidden border-r bg-muted/40 md:block">
		<div class="flex h-full max-h-screen flex-col gap-2">
			<div class="flex h-14 items-center border-b px-4 lg:h-[60px] lg:px-6">
				<a href="{base}/" class="flex items-center gap-2 font-semibold">
					<span class=""><img src={`${base}/_logo.png`} /></span>
				</a>
			</div>
			<div class="flex-1">
				<nav class="grid items-start px-2 text-sm font-medium lg:px-4">
					<NewMenu />
				</nav>
			</div>
			<div class="mt-auto p-4">
				<RocketPillCard />
			</div>
		</div>
	</div>
	<div class="flex h-dvh flex-col">
		<header
			class="flex h-14 items-center justify-center gap-4 border-b bg-muted/40 px-4 lg:h-[60px] lg:px-6"
		>
			<Sheet.Root>
				<Sheet.Trigger asChild let:builder>
					<Button variant="outline" size="icon" class="shrink-0 md:hidden" builders={[builder]}>
						<Menu class="h-5 w-5" />
						<span class="sr-only">Toggle navigation menu</span>
					</Button>
				</Sheet.Trigger>
				<Sheet.Content side="left" class="flex flex-col">
					<nav class="grid gap-2 text-lg font-medium">
						<a href="##" class="flex items-center gap-2 text-lg font-semibold">
							<span><img src={`${base}/_logo.png`} /></span>
						</a>
						<NewMenu />
					</nav>
					<div class="mt-auto">
						<RocketPillCard />
					</div>
				</Sheet.Content>
			</Sheet.Root>
			<NotifyMe />
			<div class="w-full flex-1 shrink">
				<Badge class="flex h-8 max-w-16 shrink-0 items-center justify-center rounded-sm"
					>{$bitcoinTip.height}</Badge
				>
			</div>
			<Button on:click={toggleMode} variant="outline" size="icon" class="shrink-0">
				<Sun
					class="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0"
				/>
				<Moon
					class="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100"
				/>
				<span class="sr-only">Toggle theme</span>
			</Button>
			<Login />
		</header>
		<div class="flex flex-1 flex-col gap-4 overflow-auto p-4 lg:gap-6 lg:p-6">
			<slot name="content"></slot>
		</div>
	</div>
</div>
