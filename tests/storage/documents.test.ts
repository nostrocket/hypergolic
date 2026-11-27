import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DiskSQLite, registration} from './harness.ts';
import {openShellDatabase} from '../../src/storage/database.ts';

test('documents survive reopen and reject concurrent stale writes while isolating accounts and napplets', async () => {
  const disk = new DiskSQLite();
  const owner = registration();
  let db = await openShellDatabase(disk,'android');
  const file = '/Documents/Example.txt';
  const request = (type: string, fields: Record<string,unknown> = {}) => db.document!(owner,{type:'fs.' + type,...fields});
  const write = (data:string, options:object) => request('write',{path:file,data:btoa(data),options});
  try {
    assert.deepEqual(await write('hello',{ifAbsent:true}),{result:{bytesWritten:5,size:5}});
    const {metadata} = await request('stat',{path:file});
    const ifRevision = (metadata as {revision:string}).revision;
    const results = await Promise.all([write('welcome',{ifRevision}),write('stale',{ifRevision})]);
    assert.deepEqual(results[1],{error:'conflict'});
    const {entries} = await request('list',{path:'/Documents'});
    assert.equal((entries as unknown[]).length,1);
    assert.deepEqual(await request('read',{path:file,options:{offset:1,length:3}}),{result:{data:btoa('elc'),offset:1,bytesRead:3,eof:false,size:7}});
    for (const path of ['/Documents/../bad','/Documents//bad','/Documents/a\\b']) {
      assert.deepEqual(await request('write',{path,data:''}),{error:'invalid-path'});
    }
    assert.deepEqual(await request('write',{path:file,data:'YR=='}),{error:'invalid-data'});
    for (const other of [registration({appId:'other'}),registration({user:'aa'.repeat(32)}),registration({publisher:'bb'.repeat(32)})]) {
      assert.deepEqual(await db.document!(other,{type:'fs.stat',path:file}),{error:'not-found'});
    }
    await db.close();
    db = await openShellDatabase(disk,'ios');
    assert.deepEqual(await request('read',{path:file}),{result:{data:btoa('welcome'),offset:0,bytesRead:7,eof:true,size:7}});
  } finally {
    await db.close();
    disk.cleanup();
  }
});
