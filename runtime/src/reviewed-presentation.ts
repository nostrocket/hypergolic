import {reviewedPresentationApp, type PresentationPin} from './reviewed-presentation-pin';
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
const feedCss = `@media(max-width:720px){
html body main.svelte-1n46o8q{grid-template-columns:minmax(0,1fr);height:auto;min-block-size:100vh}
html body .rail.svelte-1n46o8q{border-inline-end:0;border-block-end:1px solid var(--hg-border-muted,#242424)}
html body .saved-list.svelte-1n46o8q{max-block-size:160px;flex:auto}
html body .editor.svelte-1n46o8q,html body .field.svelte-1n46o8q,html body .name-field.svelte-1n46o8q{min-inline-size:0}
html body .body.svelte-1n46o8q{flex:none;overflow-y:visible;min-inline-size:0}
html body .seg.svelte-1n46o8q,html body .actions.svelte-1n46o8q{flex-wrap:wrap;max-inline-size:100%}
html body main.svelte-1n46o8q button{min-block-size:44px;min-inline-size:44px}
html body .editor.svelte-1n46o8q input,html body .editor.svelte-1n46o8q textarea{min-inline-size:0;max-inline-size:100%;min-block-size:44px}
html body .status.svelte-1n46o8q{flex:1 1 100%;white-space:normal;overflow-wrap:anywhere}
html body .saved-item.svelte-1n46o8q{display:grid;grid-template-columns:minmax(0,1fr) 44px 44px}
html body .saved-item.svelte-1n46o8q button{box-sizing:border-box}
html body .saved-open-feed.svelte-1n46o8q,html body .saved-del.svelte-1n46o8q{position:static}
html body .saved-main.svelte-1n46o8q{padding-inline-end:0;min-inline-size:0}
html body .saved-name.svelte-1n46o8q{min-inline-size:0}
}`;
const creatorCss = `@media(max-width:720px){
html body main.svelte-1n46o8q{height:auto;min-block-size:100vh}
html body .meta.svelte-1n46o8q{grid-template-columns:minmax(0,1fr)}
html body .field.svelte-1n46o8q,html body .dtag-row.svelte-1n46o8q{min-inline-size:0}
html body .dtag.svelte-1n46o8q{height:auto;min-block-size:44px;box-sizing:border-box;white-space:normal;overflow-wrap:anywhere;overflow:visible;text-overflow:clip;line-height:1.5;padding-block:8px}
html body .dtag-row.svelte-1n46o8q{align-items:stretch}
html body main.svelte-1n46o8q button.svelte-1n46o8q,html body main.svelte-1n46o8q input[type=text]{min-block-size:44px;min-inline-size:44px;box-sizing:border-box}
html body .title-field.svelte-1n46o8q input{inline-size:100%;min-inline-size:0}
html body .add.svelte-1n46o8q{flex-wrap:wrap;align-items:stretch}
html body .shortcode-field.svelte-1n46o8q{flex:1 1 100%}
html body .staged.svelte-1n46o8q{flex:none;min-block-size:120px;overflow:visible}
html body .chip.svelte-1n46o8q{max-inline-size:100%;box-sizing:border-box}
html body .code.svelte-1n46o8q{min-inline-size:0;overflow-wrap:anywhere}
html body .remove.svelte-1n46o8q{flex:none}
}`;

const styles = {
  'emoji-browser': emojiCss,
  'creator-signals': signalsCss,
  mapplets: mappletsCss,
  'feed-builder': feedCss,
  'emoji-pack-creator': creatorCss,
};

/** Host presentation only, after original artifact verification. Future versions receive no override. */
export function injectReviewedPresentation(html: string, metadata: PresentationPin): string {
  const app = reviewedPresentationApp(metadata);
  if (!app) return html;
  const css = styles[app];
  const csp = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
  if (!csp.test(html)) throw new Error('Reviewed presentation requires host CSP');
  return html.replace(csp, value => value + '<style id="hypergolic-reviewed-presentation">' + css + '</style>');
}
