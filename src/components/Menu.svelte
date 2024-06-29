<script lang="ts">
	import { base } from '$app/paths';
	import { page } from '$app/stores';
	import { Badge } from '@/components/ui/badge';
	import Separator from '@/components/ui/separator/separator.svelte';
	import { Mail, Package, Pyramid, Rocket, Users } from 'lucide-svelte';

    let iconClass = "h-5 w-5 md:h-4 md:w-4"

    let getClass = (menuItem:string) => {
		//todo: make this re-run any time our path changes
        if ($page.url.pathname.includes(menuItem)) {
            return "flex items-center gap-3 rounded-lg bg-muted px-3 py-2 text-primary transition-all hover:text-primary"
        } else {
            return "flex items-center gap-3 rounded-lg px-3 py-2 text-muted-foreground transition-all hover:text-primary"
        }
        
     }

    
</script>

<a
	href="{base}/rockets"
	class={getClass("rockets")}
>
	<Rocket class={iconClass} />
	Rockets
</a>
<a
	href="##"
	class={getClass("problems")}
>
	<Pyramid class={iconClass} />
	Problem Tracker
	<Badge class="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full">6</Badge>
</a>
<a
	href="##"
	class={getClass("products")}
>
	<Package class={iconClass} />
	Products
</a>
<a
	href="##"
	class={getClass("people")}
>
	<Users class={iconClass} />
	People
</a>
<Separator />
<a
	href="##"
	class={getClass("inbox")}
>
	<Mail class={iconClass} />
	Inbox
</a>
