<script lang="ts">
	import { base } from '$app/paths';
	import { page } from '$app/stores';
	import { Badge } from '@/components/ui/badge';
	import Separator from '@/components/ui/separator/separator.svelte';
	import { currentUser, devmode } from '@/stores/session';
	import {
		Code,
		GitBranch,
		HelpCircle,
		Mail,
		Package,
		Pyramid,
		Rocket,
		Users
	} from 'lucide-svelte';
	import { GitAltBrand, TelegramBrand } from 'svelte-awesome-icons';

	let iconClass = 'h-5 w-5 md:h-4 md:w-4';

	$: getClass = (menuItem: string) => {
		if ($page.url.pathname.startsWith(`/${menuItem}`) || (menuItem == 'dev' && $devmode)) {
			return 'flex items-center gap-3 rounded-lg bg-muted px-3 py-2 text-primary transition-all hover:text-primary';
		} else {
			return 'flex items-center gap-3 rounded-lg px-3 py-2 text-muted-foreground transition-all hover:text-primary';
		}
	};
</script>

{#if $currentUser}
	<a href="{base}/inbox" class={getClass('inbox')}>
		<Mail class={iconClass} />
		Inbox
		<Badge class="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full">1</Badge>
	</a>
	<Separator class="dark:bg-slate-700" />
{/if}
<a href="{base}/rockets" class={getClass('rockets')}>
	<Rocket class={iconClass} />
	Rockets
</a>
<a href="{base}/products" class={getClass('products')}>
	<Package class={iconClass} />
	Products
</a>
<a href="{base}/problems" class={getClass('problems')}>
	<Pyramid class={iconClass} />
	Problem Tracker
	<!-- <Badge class="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full">6</Badge> -->
</a>

<!-- <a href="##" class={getClass('people')}>
	<Users class={iconClass} />
	People
</a> -->
<Separator class="dark:bg-slate-700" />
<a href="https://github.com/nostrocket/hypergolic" class={getClass('_')}>
	<GitAltBrand class={iconClass} />
	Source
</a>
<a href="https://t.me/nostrocket" class={getClass('_')}>
	<TelegramBrand class={iconClass} />
	Telegram Group
</a>
<a href="{base}/help" class={getClass('help')}>
	<HelpCircle class={iconClass} />
	Help
</a>
<Separator class="dark:bg-slate-700" />
<a
	href="#"
	class={getClass('dev')}
	on:click={() => {
		devmode.update((dm) => {
			return !dm;
		});
	}}
>
	<Code class={iconClass} />
	Dev Mode
</a>
