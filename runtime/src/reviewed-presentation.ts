type PresentationMetadata = Readonly<{published: boolean; appId: string; aggregateHash: string}>;
const emojiVersion = '24b16ab3eb550d50eff01a3c42c6e56c3a81da4cf6914b11dc766d8575767381';
const signalsVersion = 'a3320b9d78a3506bca07cb3ffcc09c2db3f36e5493574834c3cb14fc96ebac58';
const mappletsVersion = '3a5eeb98b3251a48a3ff1e32cb92ce76b7488b721dd492ae1659e90eeffe76f5';
const emojiCss = `@media(max-width:720px){
html body main.svelte-1n46o8q{grid-template-columns:minmax(0,1fr)}
html body .topbar.svelte-1n46o8q,html body .toolbar.svelte-1n46o8q{flex-wrap:wrap;min-inline-size:0}
html body .topbar.svelte-1n46o8q>p{min-inline-size:0;overflow-wrap:anywhere}
html body .toolbar.svelte-1n46o8q input{flex:1 1 100%;inline-size:100%;min-block-size:44px}
html body .group-modes.svelte-1n46o8q{flex-wrap:wrap;max-inline-size:100%}
html body main.svelte-1n46o8q button.svelte-1n46o8q{min-block-size:44px}
html body .layout.svelte-1n46o8q{grid-template-columns:minmax(0,1fr);min-inline-size:0}
html body .detail.svelte-1n46o8q{grid-template-columns:minmax(0,1fr)}
html body .detail.svelte-1n46o8q button{max-inline-size:100%;white-space:normal;overflow-wrap:anywhere}
}`;
const signalsCss = `html body input.svelte-1n46o8q,html body button.svelte-1n46o8q{
background:var(--hg-bg-surface,var(--hg-surface,#111d29));
color:var(--hg-text-primary,var(--hg-text,#eef3f7))
}`;
const mappletsCss = `@media(max-width:720px){
html body .topbar{flex-direction:column;align-items:stretch;min-inline-size:0}
html body .topbar .actions{flex-wrap:wrap;max-inline-size:100%;overflow-x:visible}
html body .topbar .actions-group{flex-wrap:wrap;min-inline-size:0;max-inline-size:100%}
html body .topbar .actions button,html body .topbar .actions select{min-block-size:44px}
html body .topbar .actions select{block-size:44px}
html body .topbar .actions button{min-inline-size:44px}
}`;

/** Host presentation only, after original artifact verification. Future versions receive no override. */
export function injectReviewedPresentation(html: string, metadata: PresentationMetadata): string {
  if (!metadata.published) return html;
  const css = metadata.appId === 'emoji-browser' && metadata.aggregateHash === emojiVersion ? emojiCss
    : metadata.appId === 'creator-signals' && metadata.aggregateHash === signalsVersion ? signalsCss
    : metadata.appId === 'mapplets' && metadata.aggregateHash === mappletsVersion ? mappletsCss : null;
  if (css === null) return html;
  const csp = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
  if (!csp.test(html)) throw new Error('Reviewed presentation requires host CSP');
  return html.replace(csp, value => value + '<style id="hypergolic-reviewed-presentation">' + css + '</style>');
}
