<script lang="ts">
	import Bell from 'lucide-svelte/icons/bell';
	import CircleUser from 'lucide-svelte/icons/circle-user';
	import Menu from 'lucide-svelte/icons/menu';
	import Search from 'lucide-svelte/icons/search';

	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import { Rocket } from 'lucide-svelte';
	import NewMenu from '../components/Menu.svelte';
	import RocketPillCard from '../components/RocketPillCard.svelte';
	import { base } from '$app/paths';
	import Login from '../components/Login.svelte';
	import { page } from '$app/stores';

	export let title = '';
</script>

<div class="grid min-h-screen w-full md:grid-cols-[220px_1fr] lg:grid-cols-[280px_1fr]">
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
		<header class="flex h-14 items-center gap-4 border-b bg-muted/40 px-4 lg:h-[60px] lg:px-6">
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

			<div
				class="flex items-center bg-indigo-800 p-2 leading-none text-indigo-100 lg:inline-flex lg:rounded-full"
				role="alert"
			>
				<span class="mr-3 flex rounded-full bg-indigo-500 px-2 py-1 text-xs font-bold uppercase"
					>Alert</span
				>
				<span class="mr-2 flex-auto text-left font-semibold"
					>Nostrocket is sooooo not ready yet but whatever</span
				>
			</div>

			<div class="w-full flex-1">
				<form>
					<div class="relative">
						<Search class="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
						<Input
							type="search"
							placeholder="Search Nostrocket..."
							class="w-full appearance-none bg-background pl-8 shadow-none md:w-2/3 lg:w-1/3"
						/>
					</div>
				</form>
			</div>
			<Login />
		</header>
		<div class="flex flex-1 flex-col gap-4 overflow-auto p-4 lg:gap-6 lg:p-6">
			<slot name="content"></slot>
		</div>
	</div>
</div>
