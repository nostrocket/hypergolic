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


export function unixToRelativeTime(timestamp: number): string {
    const currentTime = Date.now();
    const secondsAgo = Math.floor((currentTime - timestamp) / 1000);
    
    if (secondsAgo < 60) {
    return `${secondsAgo} seconds ago`;
    } else if (secondsAgo < 3600) {
    const minutesAgo = Math.floor(secondsAgo / 60);
    return `${minutesAgo} minute${minutesAgo === 1 ? '' : 's'} ago`;
    } else if (secondsAgo < 86400) {
    const hoursAgo = Math.floor(secondsAgo / 3600);
    return `${hoursAgo} hour${hoursAgo === 1 ? '' : 's'} ago`;
    } else if (secondsAgo < 604800) {
    const daysAgo = Math.floor(secondsAgo / 86400);
    return `${daysAgo} day${daysAgo === 1 ? '' : 's'} ago`;
    } else {
    const formattedDate = new Date(timestamp).toLocaleString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
    });
    return formattedDate;
    }
    }