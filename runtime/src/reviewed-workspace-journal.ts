type Control = HTMLTextAreaElement | HTMLInputElement;
type Cursor = {field: number; start: number; end: number; direction: 'forward' | 'backward' | 'none'};
type Draft = {values: string[]; cursor: Cursor; scroll: number};
type Storage = {getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>};

function journalEditor() {
  const selectors = ['input[aria-label="Entry title"]', 'textarea[aria-label="Entry body"]', 'input[aria-label="Links to notes, people or relays"]'];
  const editor = () => document.querySelector('[role="group"][aria-label="Entry editor"]');
  const fields = () => selectors.map(selector => editor()?.querySelector<Control>(selector));
  const isNewEntry = () => editor()?.querySelector('button.primary')?.textContent?.trim() === 'Save entry' &&
    !document.querySelector('.note-bar, .confirm, .error');
  let lastField = 1, edits = 0;
  let composing = false;
  let pendingFocus: (() => void) | undefined;
  window.addEventListener('focusin', event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
      lastField = fields().findIndex(field => field === event.target);
  }, true);
  window.addEventListener('compositionstart', () => { composing = true; edits++; }, true);
  window.addEventListener('compositionend', () => { composing = false; edits++; }, true);
  for (const type of ['input', 'pointerdown', 'keydown']) {
    window.addEventListener(type, event => { if (event.isTrusted) { edits++; pendingFocus = undefined; } }, true);
  }
  function capture(): Draft | null {
    if (!isNewEntry() || composing) return null;
    const controls = fields(), active = controls[lastField];
    if (!active || controls.some(control => !control) || active.selectionStart === null || active.selectionEnd === null) return null;
    return {values: controls.map(control => control!.value), cursor: {field: lastField, start: active.selectionStart,
      end: active.selectionEnd, direction: active.selectionDirection ?? 'none'}, scroll: controls[1]!.scrollTop};
  }
  function apply(draft: Draft): boolean {
    const controls = fields();
    if (!isNewEntry() || composing || controls.length !== draft.values.length || controls.some(control => !control || control.value)) return false;
    controls.forEach((control, index) => {
      control!.value = draft.values[index]!;
      control!.dispatchEvent(new Event('input', {bubbles: true}));
    });
    lastField = draft.cursor.field;
    const active = controls[lastField]!;
    const focus = () => {
      active.focus({preventScroll: true});
      active.setSelectionRange(draft.cursor.start, draft.cursor.end, draft.cursor.direction);
      controls[1]!.scrollTop = draft.scroll;
    };
    focus();
    if (document.activeElement !== active) pendingFocus = focus;
    const actual = capture();
    return !!actual && actual.values.length === draft.values.length && actual.values.every((value, index) => value === draft.values[index]) &&
      actual.cursor.start === draft.cursor.start && actual.cursor.end === draft.cursor.end;
  }
  return {editor, capture, apply, revision: () => edits, focusWhenActive() {
    const focus = pendingFocus; pendingFocus = undefined; focus?.();
  }};
}

// The signed app catches its own entry/query write errors. A successful write
// to the separate instance checkpoint cannot prove those shared entries are safe.
function journalSharedWrites(storage: Storage): () => boolean {
  const original = storage.setItem.bind(storage);
  let latest = 0, pending = 0, saved = true;
  storage.setItem = async (key, value) => {
    if (key !== 'workspace-journal:v1') return original(key, value);
    const serial = ++latest;
    pending++; saved = false;
    try { await original(key, value); saved = serial === latest; }
    catch (error) { saved = false; throw error; }
    finally { pending--; }
  };
  return () => saved && pending === 0;
}

function validJournalDraft(draft: Draft | null): draft is Draft {
  if (!draft || !Array.isArray(draft.values) || draft.values.length !== 3 || !draft.values.every(value => typeof value === 'string')) return false;
  const c = draft.cursor;
  return !!c && Number.isInteger(c.field) && c.field >= 0 && c.field < 3 && Number.isInteger(c.start) &&
    Number.isInteger(c.end) && c.start >= 0 && c.end >= c.start && c.end <= draft.values[c.field]!.length &&
    ['backward', 'forward', 'none'].includes(c.direction) && Number.isFinite(draft.scroll);
}

// Journal loads saved entries asynchronously. Their presence changes its initial screen.
function waitForJournalEditor(form: ReturnType<typeof journalEditor>, revision: number, deadline: number): Promise<void> {
  return new Promise(resolve => {
    let opened = false;
    const observer = new MutationObserver(check);
    const timeout = window.setTimeout(finish, Math.max(0, deadline - performance.now()));
    function finish() { observer.disconnect(); clearTimeout(timeout); resolve(); }
    function check() {
      if (form.editor() || form.revision() !== revision || performance.now() >= deadline) { finish(); return; }
      if (!opened && document.querySelector('section.entries')) {
        const button = document.querySelector<HTMLButtonElement>('.toolbar button.primary');
        if (button) { opened = true; button.click(); }
      }
    }
    observer.observe(document.body, {subtree: true, childList: true});
    check();
  });
}

// Runs inside the reviewed guest. No draft content crosses the control channel.
function installJournalCheckpoint(createEditor: typeof journalEditor, trackWrites: typeof journalSharedWrites,
  validDraft: typeof validJournalDraft, waitForEditor: typeof waitForJournalEditor): void {
  const key = 'hypergolic.workspace-journal.new-entry.v1';
  const storage = (window as Window & {napplet?: {storage?: Storage & {instance: Storage}}}).napplet?.storage;
  if (!storage?.instance) return;
  const sharedSaved = trackWrites(storage), form = createEditor();
  const instance = storage.instance;
  let busy = false, lastRestored = '';
  async function save(id: string): Promise<boolean> {
    const draft = form.capture(), revision = form.revision();
    if (!draft || !sharedSaved()) return false;
    const value = JSON.stringify({id, draft});
    if (value.length > 262144) return false;
    await instance.setItem(key, value);
    return sharedSaved() && revision === form.revision() && JSON.stringify(form.capture()) === JSON.stringify(draft);
  }
  async function restore(id: string): Promise<boolean> {
    if (lastRestored === id) return true;
    const revision = form.revision(), deadline = performance.now() + 12_000;
    const value = await instance.getItem(key);
    if (!value || value.length > 262144) return false;
    const saved = JSON.parse(value);
    if (saved?.id !== id || !validDraft(saved.draft)) return false;
    await waitForEditor(form, revision, deadline);
    if (performance.now() >= deadline || revision !== form.revision() || !form.apply(saved.draft)) return false;
    lastRestored = id;
    return true;
  }
  window.addEventListener('message', async event => {
    if (!event.isTrusted || event.source !== parent || !event.data) return;
    const {type, id} = event.data;
    if (type === 'hypergolic.private.media-active' && event.data.inputBlocked === false) form.focusWhenActive();
    if ((type !== 'hypergolic.checkpoint' && type !== 'hypergolic.restoreCheckpoint') ||
        Object.keys(event.data).length !== 2 || typeof id !== 'string' || !/^resume-[A-Za-z0-9_-]{1,72}$/.test(id)) return;
    let state = 'unknown';
    if (!busy) {
      busy = true;
      try {
        if (type === 'hypergolic.checkpoint' && await save(id)) state = 'saved';
        if (type === 'hypergolic.restoreCheckpoint' && await restore(id)) state = 'restored';
      } catch { /* A failed storage operation leaves the card live. */ }
      finally { busy = false; }
    }
    parent.postMessage({type: type + '.result', id, state}, '*');
  });
}

export function injectJournalCheckpoint(html: string): string {
  const csp = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
  if (!csp.test(html)) throw new Error('Workspace Journal checkpoint requires host CSP');
  const helpers = [journalEditor, journalSharedWrites, validJournalDraft, waitForJournalEditor].map(fn => fn.toString());
  return html.replace(csp, value => `${value}<script>(${installJournalCheckpoint.toString()})(${helpers.join(',')});</script>`);
}
