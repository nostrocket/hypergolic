export function element<T extends HTMLElement>(id: string): T {
  const target = document.getElementById(id);
  if (!target) throw new Error('Missing fixture element: ' + id);
  return target as T;
}
