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

/** Deliver a guest-local event after a browser activation whose native submit is sandboxed. */
function dispatchLocalFormSubmit(): void {
  if (typeof SubmitEvent !== 'function') return;
  const Submit = SubmitEvent;
  const {closest, matches, hasAttribute} = Element.prototype;
  const {reportValidity} = HTMLFormElement.prototype;
  const {hasFocus} = Document.prototype;
  const schedule = window.setTimeout.bind(window);
  const {dispatchEvent} = EventTarget.prototype;
  const explicitSubmit = 'button[type="submit"]:not(:disabled)';
  const formNavigation = ['action', 'method', 'target', 'enctype'];
  const buttonOverrides = ['formaction', 'formmethod', 'formtarget', 'formenctype', 'formnovalidate'];
  const observed = new WeakMap<HTMLFormElement, Event>();
  const synthetic = new WeakSet<Event>();
  let live = true;
  const eligible = (button: HTMLButtonElement, form: HTMLFormElement): boolean =>
    form.ownerDocument === document && form.isConnected && button.ownerDocument === document &&
    button.isConnected && button.form === form &&
    matches.call(button, explicitSubmit) &&
    !formNavigation.some(name => hasAttribute.call(form, name)) &&
    !buttonOverrides.some(name => hasAttribute.call(button, name));

  window.addEventListener('submit', event => {
    if (event.target instanceof HTMLFormElement && !synthetic.has(event)) observed.set(event.target, event);
  }, true);
  window.addEventListener('click', event => {
    if (!event.isTrusted || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        !(event.target instanceof Element)) return;
    const button = closest.call(event.target, explicitSubmit);
    if (!(button instanceof HTMLButtonElement) || !button.form || !eligible(button, button.form)) return;
    const active = document.activeElement;
    if (event.detail === 0 && active && matches.call(active, 'textarea, select, input[type="file"]')) return;
    const form = button.form;
    const before = observed.get(form);
    // A task runs after the author click handlers and any ordinary submit event.
    schedule(() => {
      if (!live || document.hidden || !hasFocus.call(document) || event.defaultPrevented ||
          observed.get(form) !== before || !eligible(button, form)) return;
      if (!hasAttribute.call(form, 'novalidate') && !reportValidity.call(form)) return;
      const submit = new Submit('submit', {bubbles: true, cancelable: true, submitter: button});
      synthetic.add(submit);
      dispatchEvent.call(form, submit);
    }, 0);
  }, true);
  window.addEventListener('pagehide', () => { live = false; }, {once: true});
}

export function injectAndroidGuestHelpers(html: string): string {
  if (window.location.origin !== androidHostOrigin) return html;
  const helpers = `(${revealFocusedEditorOnShrink.toString()})();(${dispatchLocalFormSubmit.toString()})();`;
  return html.replace(leadingCsp, meta => `${meta}<script>${helpers}</script>`);
}
