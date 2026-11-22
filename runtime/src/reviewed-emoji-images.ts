import {reviewedPresentationApp, type PresentationPin} from './reviewed-presentation-pin';

/** The pinned guest refreshes its cache before pending resolver images finish loading. */
function installEmojiImages(): void {
  const revoke = URL.revokeObjectURL.bind(URL);
  const deferred = new Set<string>();
  const referenced = () => new Set(Array.from(document.images, image => image.getAttribute('src')));
  const sweep = () => {
    const sources = referenced();
    for (const url of deferred) {
      if (sources.has(url)) continue;
      deferred.delete(url);
      revoke(url);
    }
    if (deferred.size === 0) observer.disconnect();
  };
  const observer = new MutationObserver(sweep);
  URL.revokeObjectURL = url => {
    if (!referenced().has(url)) {revoke(url);return;}
    // Keep the URL through resolver-to-card handoff. Release after its last image
    // is removed or changes source; document unload releases all remaining URLs.
    deferred.add(url);
    observer.observe(document, {subtree:true, childList:true, attributes:true, attributeFilter:['src']});
  };
}

export function injectEmojiImages(html: string, metadata: PresentationPin): string {
  if (reviewedPresentationApp(metadata) !== 'emoji-browser') return html;
  const csp = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
  if (!csp.test(html)) throw new Error('Emoji image compatibility requires host CSP');
  return html.replace(csp, value => `${value}<script data-hypergolic-emoji-images>(${installEmojiImages.toString()})();</script>`);
}
