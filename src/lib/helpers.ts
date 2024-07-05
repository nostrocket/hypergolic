import type { NDKEvent } from "@nostr-dev-kit/ndk";

export function getRocketURL(e:NDKEvent):string {

    let ignitionID = undefined;
    if (e.getMatchingTags('ignition') && e.getMatchingTags('ignition')[0] && e.getMatchingTags('ignition')[0][1]) {
        ignitionID = e.getMatchingTags('ignition')[0][1]
    }
    if (!ignitionID) {
        ignitionID = e.id
    }
    let d = e.getMatchingTags('d')[0][1]
    let p = e.pubkey
    return `${ignitionID}?d=${d}&p=${p}`
}

export function getMission(rocketEvent:NDKEvent):string {
    if (rocketEvent.getMatchingTags('mission') && rocketEvent.getMatchingTags('mission')[0] && rocketEvent.getMatchingTags('mission')[0][1]) {
        return rocketEvent.getMatchingTags('mission')[0][1]
    }
    return ""
}