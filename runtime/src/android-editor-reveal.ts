const androidHostOrigin = 'https://appassets.androidplatform.net';
const leadingCsp = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;

/** The injected function uses only the current opaque guest document. */
function revealFocusedEditorOnShrink(): void {
  const editableInputs = ['text', 'search', 'email', 'url', 'tel', 'password', 'number'];
  const scroll = Element.prototype.scrollIntoView;
  const editable = (field: Element | null): field is HTMLElement => {
    if (!(field instanceof HTMLElement) || field === document.body || field === document.documentElement ||
        field.closest('[hidden], [inert]')) return false;
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      return !field.readOnly && !field.matches(':disabled') &&
        (field instanceof HTMLTextAreaElement || editableInputs.includes(field.type));
    }
    return field.isContentEditable && field.hasAttribute('contenteditable') &&
      field.getAttribute('aria-readonly') !== 'true' && field.getAttribute('aria-disabled') !== 'true';
  };
  const visible = (field: HTMLElement): boolean => {
    if (typeof field.checkVisibility === 'function') {
      return field.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
    }
    const style = getComputedStyle(field);
    return style.visibility === 'visible' && style.opacity !== '0';
  };

  let height = 0;
  let pending: number | undefined;
  const cancel = (): void => {
    if (pending !== undefined) cancelAnimationFrame(pending);
    pending = undefined;
  };
  const onResize = (event: Event): void => {
    if (!event.isTrusted) return;
    const before = height;
    height = innerHeight;
    cancel();
    if (height <= 0 || height >= before || document.hidden || !document.hasFocus()) return;
    const field = document.activeElement;
    if (!editable(field)) return;
    pending = requestAnimationFrame(() => {
      pending = undefined;
      const current = innerHeight;
      if (current <= 0 || current >= before || document.hidden || !document.hasFocus() ||
          document.activeElement !== field || !field.isConnected || !editable(field)) return;
      const bounds = field.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0 || (bounds.top >= 0 && bounds.bottom <= current) ||
          !visible(field)) return;
      scroll.call(field, {block: 'nearest', inline: 'nearest', behavior: 'instant'});
    });
  };
  const onLoad = (): void => {
    height = innerHeight;
    window.addEventListener('resize', onResize);
  };
  window.addEventListener('load', onLoad, {once: true});
  window.addEventListener('pagehide', () => {
    cancel();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('load', onLoad);
  }, {once: true});
}

export function injectAndroidEditorReveal(html: string): string {
  if (window.location.origin !== androidHostOrigin) return html;
  return html.replace(leadingCsp, meta => `${meta}<script>(${revealFocusedEditorOnShrink.toString()})();</script>`);
}
