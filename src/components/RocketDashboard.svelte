<script lang="ts">
      
    import * as Breadcrumb from "$lib/components/ui/breadcrumb/index.js";
    import { RocketProduct } from "@/event_helpers/rockets";
    import type { NDKEvent } from "@nostr-dev-kit/ndk";
    import { writable, type Writable } from "svelte/store";
    import MeritsAndSatflow from "./MeritsAndSatflow.svelte";
    import ProductFomo from "./ProductFomo.svelte";

    export let rocket:NDKEvent;

    
    let products: Writable<RocketProduct[]> = writable([])

    $: {
      //fetch products from rocket and populate a store of them
      let _products:RocketProduct[] = []
      for (let p of rocket.getMatchingTags("product")) {
        _products.push(new RocketProduct(p))
      }
      products.set(_products)
    }

    
    

  </script>
    <div class="flex flex-col sm:gap-4">
      <header
        class="sticky top-0 z-30 flex h-14 items-center gap-4 border-b bg-background px-4 sm:static sm:h-auto sm:border-0 sm:bg-transparent sm:px-6"
      >
        
        <Breadcrumb.Root class="hidden md:flex">
          <Breadcrumb.List>
            <Breadcrumb.Item>
              <Breadcrumb.Link href="##">{rocket.getMatchingTags('d')[0][1]}</Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator />
            <Breadcrumb.Item>
              <Breadcrumb.Page>Dashboard</Breadcrumb.Page>
            </Breadcrumb.Item>

          </Breadcrumb.List>
        </Breadcrumb.Root>
      </header>
      <main
      class="grid flex-1 items-start gap-4 p-4 sm:px-6 sm:py-0 md:gap-8 lg:grid-cols-3 xl:grid-cols-3"
    >
      <MeritsAndSatflow {rocket} />

      {#each $products as product} 
      <ProductFomo {rocket} {product} />
      {/each}
      </main>
    </div>

  