<script lang="ts">
      
    import EmptyList from "../../components/EmptyList.svelte";
import NewSidePanel from "../../layouts/SidePanel.svelte";
  </script>
  <NewSidePanel title={"Inventory"}>
    <div slot="content"><EmptyList /></div>
</NewSidePanel>