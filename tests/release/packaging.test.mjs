import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildEnvironment, buildRelease, signRelease, verifyApkMetadata, verifyCertificate } from '../../scripts/android-release.mjs';
const require = createRequire(import.meta.url);
const configure = require('../../app.config.js');
const base = require('../../app.json').expo;
const cert = 'a'.repeat(64);
const commit = 'b'.repeat(40);
const config = {applicationId: 'space.hypergolic', version: '0.1.0', versionCode: 1};
const badging = "package: name='space.hypergolic' versionCode='1' versionName='0.1.0'\nnative-code: 'arm64-v8a'\n";
const permissions = ['ACCESS_NETWORK_STATE','INTERNET','USE_BIOMETRIC','USE_FINGERPRINT']
  .map(name => `uses-permission: name='android.permission.${name}'`).concat("uses-permission: name='space.hypergolic.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'").join('\n');

test('production has its own identity; development stays compatible; unknown variants fail', () => {
  const previous = process.env.HYPERGOLIC_VARIANT;
  try {
    delete process.env.HYPERGOLIC_VARIANT;
    assert.equal(configure({config:base}).android.package,'org.nostrocket.hypergolic.dev');
    process.env.HYPERGOLIC_VARIANT='production';
    const production=configure({config:base});
    assert.equal(production.android.package,'space.hypergolic');
    assert.equal(production.extra.hypergolic.variant,'production');
    assert.equal(production.version,base.version);
    assert.equal(production.ios.bundleIdentifier,base.ios.bundleIdentifier);
    process.env.HYPERGOLIC_VARIANT='typo';
    assert.throws(()=>configure({config:base}),/variant/i);
  } finally { if(previous===undefined) delete process.env.HYPERGOLIC_VARIANT; else process.env.HYPERGOLIC_VARIANT=previous; }
});
test('build subprocesses do not inherit credentials, tokens, Expo overrides or Node hooks', () => {
  assert.deepEqual(buildEnvironment({PATH:'/bin',HOME:'/home',GH_TOKEN:'secret',NODE_OPTIONS:'hook',EXPO_PUBLIC_SECRET:'secret',HYPERGOLIC_KEYSTORE_PASSWORD:'secret',HYPERGOLIC_VARIANT:'development'}),
    {PATH:'/bin',HOME:'/home',HYPERGOLIC_VARIANT:'production',EXPO_NO_TELEMETRY:'1',EXPO_NO_DOTENV:'1'});
});
test('package checks reject incorrect identity, version, debug flags and architectures', () => {
  verifyApkMetadata(badging,'',config);
  for(const changed of [badging.replace('space.hypergolic','other.app'),badging.replace("versionCode='1'","versionCode='2'"),badging+'application-debuggable\n',badging.replace("'arm64-v8a'","'arm64-v8a' 'x86_64'")]) {
    assert.throws(()=>verifyApkMetadata(changed,'',config));
  }
  for(const attribute of ['debuggable','testOnly']) {
    assert.throws(()=>verifyApkMetadata(badging,`A: android:${attribute}(0x1234)=(type 0x12)0xffffffff`,config));
  }
});
test('signer verification requires the registered certificate and only one signer', () => {
  const output=`Signer #1 certificate SHA-256 digest: ${cert}`;
  verifyCertificate(output,cert);
  assert.throws(()=>verifyCertificate(output,'c'.repeat(64)));
  assert.throws(()=>verifyCertificate(output,null));
  assert.throws(()=>verifyCertificate(output+`\nSigner #2 certificate SHA-256 digest: ${cert}`,cert));
});

async function fixture(t) {
  const directory=await mkdtemp(path.join(tmpdir(),'hypergolic-release-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=path.join(directory,'source');
  const input=path.join(directory,'input');
  const output=path.join(directory,'output');
  await mkdir(path.join(root,'config'),{recursive:true}); await mkdir(input);
  await writeFile(path.join(root,'app.json'),JSON.stringify({expo:{version:'0.1.0',android:{versionCode:1}}}));
  await writeFile(path.join(root,'config/android-release.json'),JSON.stringify({applicationId:'space.hypergolic',signingCertificateSha256:cert}));
  const bytes=Buffer.from('controlled unsigned APK');
  await writeFile(path.join(input,'unsigned.apk'),bytes);
  const receipt={schemaVersion:1,...config,sourceCommit:commit,unsignedSha256:createHash('sha256').update(bytes).digest('hex')};
  await writeFile(path.join(input,'input.json'),JSON.stringify(receipt));
  const key=path.join(directory,'test-key'); await writeFile(key,'fixture only');
  const env={PATH:process.env.PATH,ANDROID_HOME:'/sdk',HYPERGOLIC_KEYSTORE_PATH:key,HYPERGOLIC_KEY_ALIAS:'fixture',HYPERGOLIC_KEYSTORE_PASSWORD:'fixture-store',HYPERGOLIC_KEY_PASSWORD:'fixture-key',GH_TOKEN:'never-forward'};
  const calls=[];
  const run=(name,args,options)=> {
    calls.push({name,args,env:options.env});
    assert.equal(options.env.GH_TOKEN,undefined);
    if(args[0]==='sign') {
      assert.equal(options.env.HYPERGOLIC_KEYSTORE_PASSWORD,env.HYPERGOLIC_KEYSTORE_PASSWORD);
      assert(!args.includes(env.HYPERGOLIC_KEYSTORE_PASSWORD));
      // A synchronous command returns after writing its output.
      require('node:fs').writeFileSync(args[args.indexOf('--out')+1],'controlled signed APK');
    } else assert.equal(options.env.HYPERGOLIC_KEYSTORE_PASSWORD,undefined);
    if(name==='git') return args[0]==='status'?'':commit;
    if(args[1]==='badging') return badging;
    if(args[1]==='permissions') return permissions;
    if(args[0]==='verify') return `Signer #1 certificate SHA-256 digest: ${cert}`;
    if(args[0]==='-P') require('node:fs').writeFileSync(args.at(-1),'aligned fixture');
    return '';
  };
  return {root,input,output,env,run,calls,receipt};
}
test('signing writes a checksum and source receipt; credentials reach only apksigner sign',async t=>{
  const f=await fixture(t);
  await signRelease(f);
  const result=JSON.parse(await readFile(path.join(f.output,'build.json')));
  assert.equal(result.sourceCommit,commit);
  assert.equal(result.signingCertificateSha256,cert);
  assert.equal(await readFile(path.join(f.output,'SHA256SUMS'),'utf8'),`${result.sha256}  ${result.apk}\n`);
  await assert.rejects(signRelease(f),/Output already exists/);
});
test('tampered bytes and wrong source receipts fail before accessing signing credentials',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.input,'unsigned.apk'),'tampered');
  await assert.rejects(signRelease(f),/does not match/);
  assert(!f.calls.some(call=>call.args[0]==='sign'));
  await assert.rejects(access(f.output));
});
test('wrong signing certificate removes the incomplete candidate',async t=>{
  const f=await fixture(t);
  const run=(name,args,options)=>args[0]==='verify'?`Signer #1 certificate SHA-256 digest: ${'c'.repeat(64)}`:f.run(name,args,options);
  await assert.rejects(signRelease({...f,run}),/unexpected certificate/);
  await assert.rejects(access(f.output));
});
test('unregistered production certificate and dirty source fail closed',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.root,'config/android-release.json'),JSON.stringify({applicationId:'space.hypergolic',signingCertificateSha256:null}));
  await assert.rejects(signRelease(f),/Register the production certificate/);
  const run=(name,args,options)=>name==='git'&&args[0]==='status'?' M app.json':f.run(name,args,options);
  await assert.rejects(buildRelease({...f,run}),/clean, committed/);
  assert(!f.calls.some(call=>call.args[0]==='sign'));
});
