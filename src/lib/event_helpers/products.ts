import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type NDKSvelte from "@nostr-dev-kit/ndk-svelte";

export async function fetchEvent(id:string, ndk:NDKSvelte):Promise<NDKEvent> {
    return new Promise((resolve)=>{
        ndk.fetchEvent(id).then((e) => {
            if (e) {
               resolve(e)
            } else {
                let _p = ndk.storeSubscribe([{ ids: [id] }], { subId: id, closeOnEose: true });
                _p.subscribe((x) => {
                    if (x[0]) {
                        let e = x[0]
                        _p.unsubscribe();
                        resolve(e)
                    }
                });
            }
        });
    })
}


