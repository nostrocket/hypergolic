import {LEGACY_RECIPE_MODULES} from './legacy-recipe-modules';
/** The dependency map is host-supplied code, never part of the original signed artifact. */
function installLegacyModules(modules: Readonly<Record<string, string>>): void {
  const urls: string[] = [], imports: Record<string, string> = {};
  for (const [specifier, source] of Object.entries(modules)) {
    const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
    urls.push(url); imports[specifier] = url;
  }
  const map = document.createElement('script'); map.type = 'importmap'; map.textContent = JSON.stringify({imports});
  document.head.append(map);
  window.addEventListener('pagehide', () => {for (const url of urls) URL.revokeObjectURL(url);}, {once: true});
}
export function injectLegacyRecipeModules(html: string): string {
  const encoded = JSON.stringify(LEGACY_RECIPE_MODULES).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const code = '(' + installLegacyModules.toString() + ')(' + encoded + ');';
  const cspStart = html.indexOf('<meta http-equiv="Content-Security-Policy"');
  const cspEnd = html.indexOf('>', cspStart);
  if (cspStart < 0 || cspEnd < 0) throw new Error('Legacy modules require host CSP');
  return html.slice(0, cspEnd + 1) + '<script>' + code.replaceAll('</script', '<\\/script') + '</script>' + html.slice(cspEnd + 1);
}
