import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(realpathSync(path.join(root,'runtime/node_modules/vite/package.json')));
const {build}=require('esbuild');

for(const variant of ['production','development',null,'unknown']) {
  test(`bundled lab entry and installed build information: ${variant}`,async t=>{
    const directory=await mkdtemp(path.join(tmpdir(),'hypergolic-public-build-'));
    t.after(()=>rm(directory,{recursive:true,force:true}));
    const outfile=path.join(directory,'compiled.mjs');
    const config=variant===null?null:{version:'0.1.0',android:{versionCode:1},extra:{hypergolic:{variant}}};
    const mocks={
      'expo-constants':`export default {expoConfig:${JSON.stringify(config)}};`,
      'react-native':`export const Platform={OS:'android'};`,
      'react':`export const useRef=value=>({current:value});`,
    };
    await build({stdin:{contents:"export {useBundledNapplets} from './src/shell/useBundledNapplets'; export {buildInfo,developerToolsEnabled} from './src/config/build-info'; export {initialWorkspaceForBuild} from './src/shell/initial-workspace';",resolveDir:root},
      bundle:true,format:'esm',platform:'node',outfile,plugins:[{name:'native-build-fixture',setup(builder){
        builder.onResolve({filter:/^(expo-constants|react-native|react)$/},args=>({path:args.path,namespace:'fixture'}));
        builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:mocks[args.path],loader:'js'}));
      }}]});
    const module=await import(pathToFileURL(outfile));
    const initial=module.initialWorkspaceForBuild();
    assert.equal(initial.sessions.length,variant==='development'?3:0);
    const effects=[];
    const open=module.useBundledNapplets({current:{current:{sessions:[],focusedId:null,overview:true}},runtime:null,
      position:{set:value=>effects.push(['position',value])},progress:{set:value=>effects.push(['progress',value])},
      change:value=>effects.push(['workspace',value]),setSettings:value=>effects.push(['settings',value])});
    open('ux-lab');
    assert.equal(module.developerToolsEnabled,variant==='development');
    if(variant==='development') {
      assert.equal(effects.length,4);
      assert.equal(effects[2][1].sessions[0].source,'bundled');
    } else assert.deepEqual(effects,[]);
    assert.equal(module.buildInfo.version,variant===null?'Unknown':'0.1.0');
    assert.equal(module.buildInfo.build,variant===null?'Unknown':'1');
  });
}
