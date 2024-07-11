<script lang="ts">
      
    import * as Card from "$lib/components/ui/card/index.js";
    import * as Table from "$lib/components/ui/table/index.js";
    import type { RocketProduct } from "@/event_helpers/rockets";
    import type { NDKEvent } from "@nostr-dev-kit/ndk";
    import ProductCardFromId from "./ProductCardFromID.svelte";
	import ProductPurchases from "./ProductPurchases.svelte";

    export let product:RocketProduct;
    export let rocket:NDKEvent;
    

  </script>

<Card.Root class="sm:col-span-3">
    <Card.Header class="pb-3">
      <Card.Title>Products and Purchases</Card.Title>
      <Card.Description class="grid grid-cols-2">
        <div class=" grid-cols-1">
          <ProductCardFromId {rocket} productID={product.ID} />
      </div>
      <div class="grid-cols-1">
        <ProductPurchases {rocket} {product} />
      </div>
      </Card.Description>
    </Card.Header>
    <Card.Footer>
    </Card.Footer>
  </Card.Root>