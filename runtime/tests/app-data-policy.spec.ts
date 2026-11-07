import {test,expect,type Page} from '@playwright/test';
async function open(page:Page,query:string){await page.goto('/tests/capabilities/index.html?'+query);await expect(page.locator('#napplet')).toHaveCount(1);const frame=page.frames().find(frame=>frame.parentFrame());if(!frame)throw Error('Missing test iframe');return frame;}
for(const route of ['outbox&noRelay','relay'])test(`actual SDK resolves, registers and caches appData onReady under actual ${route} grant`,async({page})=>{
  const frame=await open(page,'soy&'+route);await expect(frame.locator('body')).toHaveAttribute('data-ready','true');
  const result=await frame.evaluate(async()=>{const shell=(window as any).napplet.shell;const ready=await shell.ready();let late:any;shell.onReady((value:any)=>{late=value;});return {ready,late,domains:ready.capabilities.domains,frozen:Object.isFrozen(ready.capabilities.appData)&&Object.isFrozen(ready.capabilities.appData.relays)};});
  expect(result.ready.capabilities.appData).toEqual({profile:'soy.app-data/1',scope:'a'.repeat(64),maxContentBytes:3072,relays:['wss://relay.damus.io'],defaultRelays:['wss://relay.damus.io']});expect(result.late).toEqual(result.ready);expect(result.frozen).toBe(true);
  if(route.startsWith('outbox'))expect(result.domains).not.toContain('relay');else expect(result.domains).not.toContain('outbox');
  const held=await page.evaluate(()=>(window as any).lab.environment());expect(held.capabilities.appData).toEqual(result.ready.capabilities.appData);
});
for(const denied of ['noIdentity','noRelay'])test(`missing ${denied} omits policy without breaking guest startup or granting a domain`,async({page})=>{
  const frame=await open(page,'soy&'+denied);await expect(frame.locator('body')).toHaveAttribute('data-ready','true');const environment=await frame.evaluate(()=>(window as any).napplet.shell.ready());expect(environment.capabilities).not.toHaveProperty('appData');expect(environment.capabilities.domains).not.toContain(denied==='noIdentity'?'identity':'relay');
});
test('a parent init carrying different policy cannot replace the pre-publisher captured policy',async({page})=>{
  const frame=await open(page,'soy&holdReady');await page.evaluate(()=>(window as any).lab.forgeAppDataInit());await expect(frame.locator('body')).toHaveAttribute('data-ready','true');
  const environment=await frame.evaluate(()=>(window as any).napplet.shell.ready());expect(environment.capabilities).not.toHaveProperty('appData');
  const held=await page.evaluate(()=>(window as any).lab.environment());expect(held.capabilities.appData.scope).toBe('a'.repeat(64));
});
