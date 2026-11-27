export interface FileChoice {
  readonly app: string;
  readonly save: boolean;
  readonly names: readonly string[];
  readonly suggestedName: string;
}
type Choice = FileChoice & { readonly finish: (name: string | null) => void };
let current: Choice | null = null;
const observers = new Set<() => void>();
function notify() { for (const update of observers) update(); }
export const filePicker = {
  snapshot: () => current,
  subscribe(update: () => void) { observers.add(update); return () => { observers.delete(update); }; },
  choose(choice: FileChoice, active: () => void): Promise<string | null> {
    active();
    if (current) return Promise.resolve(null);
    return new Promise(resolve => {
      const timer = setInterval(() => { try { active(); } catch { finish(null); } }, 100);
      const deadline = setTimeout(() => finish(null),22_000);
      function finish(name: string | null) {
        if (current?.finish !== finish) return;
        clearInterval(timer); clearTimeout(deadline);
        current = null;
        notify();
        try { active(); resolve(name); } catch { resolve(null); }
      }
      current = {...choice,finish};
      notify();
    });
  },
};
