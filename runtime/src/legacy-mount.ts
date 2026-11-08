import {createLegacyDocumentGuard} from './legacy-lifecycle';
import {createLegacyReadOnlyReceiver} from './legacy-readonly';
import type {createNativeClient} from './native-client';
import type {LegacyReadOnlyContext} from '../../src/napplets/legacy-read-only';
import {createLegacyAddressControl, type LegacyArticle} from './legacy-address';

/** Presentation and adapter wiring for an already verified, explicitly selected profile. */
export function createLegacyMount(context: LegacyReadOnlyContext | undefined, appId: string, frame: HTMLIFrameElement, source: Window,
  native: ReturnType<typeof createNativeClient>, live: () => boolean, fail: () => void, active: () => void) {
  if (!context) return undefined;
  const nonce = crypto.randomUUID();
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Read-only compatibility · public relay reads only';
  status.style.cssText = 'margin:0;padding:8px 12px;font:12px system-ui;background:#17202a;color:#fff;flex:none';
  document.body.style.cssText = 'display:flex;flex-direction:column';
  frame.style.cssText = 'flex:1;min-height:0;height:auto';
  document.body.prepend(status);
  const guard = createLegacyDocumentGuard(frame, source, nonce, fail, active);
  const recipe = appId === 'recipe-cards'; let selection: LegacyArticle | null = null;
  const selectRecipe = (article: LegacyArticle | null): void => {
    if (!live() || !guard.isActive()) throw new Error('Recipe reader is not active');
    selection = article; guard.refreshRecipeFeed();
  };
  const address = createLegacyAddressControl(recipe ? 'Open recipe by address' : 'Open by address', article => {
    if (!live()) throw new Error('Article reader is not active');
    if (recipe) {selectRecipe(article); return 'Loading selected recipe; open its card below';}
    guard.navigate('#/post/' + article.address);
  }, recipe ? () => selectRecipe(null) : undefined);
  document.body.insertBefore(address.element, frame);
  const receiver = createLegacyReadOnlyReceiver({frame, source, session: nonce, live, relays: context.relays,
    subscribe: (request, deliver) => native.legacySubscribe(request, message => guard.run(() => deliver(message), new TextEncoder().encode(JSON.stringify(message)).length)),
    close: request => native.legacyClose(request),
    status: message => {status.textContent = 'Read-only compatibility · ' + message.slice(0,256);},
    ...(recipe ? {recipeSelection: () => selection} : {}),
  });
  return {nonce, guard, receiver, close() {guard.destroy(); receiver.destroy(); address.close(); status.remove();}};
}
