import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Exercise the ZIP/ELF verifier with controlled binary inputs, including the
// distinction between ZIP alignment and actual ELF segment alignment.
test('APK verifier rejects 4 KB ELF segments, test config, missing notices and foreign ABIs', () => {
  const result=spawnSync('python3',['-B','-c',String.raw`
import importlib.util, json, pathlib, struct, tempfile, zipfile
spec=importlib.util.spec_from_file_location('verifier','scripts/verify-release-apk.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def elf(alignment=16384):
    data=bytearray(120)
    data[:6]=b'\x7fELF\x02\x01'
    struct.pack_into('<H',data,18,183)
    struct.pack_into('<Q',data,32,64)
    struct.pack_into('<HH',data,54,56,1)
    struct.pack_into('<IIQQQQQQ',data,64,1,5,0,0,0,120,120,alignment)
    return data
with tempfile.TemporaryDirectory(prefix='hypergolic-apk-content-') as directory:
    for case in ('valid','alignment','config','version','notice','abi'):
        apk=pathlib.Path(directory)/f'{case}.apk'
        config={'version':'0.1.0','android':{'package':'space.hypergolic','versionCode':1},'extra':{'hypergolic':{'variant':'production'}}}
        if case=='config': config['extra']['hypergolic']['variant']='development'
        if case=='version': config['version']='0.0.0'
        with zipfile.ZipFile(apk,'w') as archive:
            archive.writestr('assets/app.config',json.dumps(config))
            for folder in ('notices','archive-notices','cpp-notices','compiler-notices'):
                if case!='notice' or folder!='notices': archive.writestr(f'assets/{folder}/manifest.json','{}')
            abi='x86_64' if case=='abi' else 'arm64-v8a'
            archive.writestr(f'lib/{abi}/libfixture.so',elf(4096 if case=='alignment' else 16384))
        try: module.verify_apk(apk,'0.1.0','1')
        except (ValueError, KeyError): assert case!='valid',case
        else: assert case=='valid',case
`],{cwd:new URL('../../',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
