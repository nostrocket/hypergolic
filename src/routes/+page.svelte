<script>
	import Menu from "../components/Menu.svelte";
	import SidePanel from "../layouts/SidePanel.svelte";


</script>
<SidePanel>
	<div slot="menu">
		<Menu />
	</div>
	<div slot="content"></div>
</SidePanel>