import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyResourceBytes} from '../../src/resources/resource-mime.ts';
import {classifyMapPbf} from '../../src/resources/resource-map-pbf.ts';
import {MapPbfReader,MAP_PBF_LIMITS} from '../../src/resources/resource-pbf-wire.ts';
import {glyph,glyphStack,glyphFile,feature,layer,tile,join,data,scalar,string} from './resource-pbf-fixtures.ts';
const classify=(bytes:number[])=>classifyResourceBytes(new Uint8Array(bytes));
const glyphMime='application/x-protobuf',tileMime='application/vnd.mapbox-vector-tile';
test('specific glyph and MVT structure determines MIME with no extension or upstream header',()=>{
  assert.equal(classifyResourceBytes(glyphFile()),glyphMime);assert.equal(classifyResourceBytes(tile()),tileMime);
  assert.equal(classifyResourceBytes(tile([layer([])])),tileMime);
  assert.equal(classifyResourceBytes(tile([layer([],'fixture'),layer([],'\ufefffixture')])),tileMime);
  assert.equal(classifyResourceBytes(glyphFile([glyphStack([])])),glyphMime);
  const unpacked=join(scalar(3,1),scalar(4,9),scalar(4,2),scalar(4,4),scalar(2,0),scalar(2,0));
  assert.equal(classifyResourceBytes(tile([layer([unpacked])])),tileMime);
  assert.equal(classifyResourceBytes(tile([layer([feature([],[],0)])])),tileMime);
  for(const bytes of [[8,1],[10,0],[26,0],[255,255,255],[]])assert.equal(classifyMapPbf(new Uint8Array(bytes)),undefined);
  for(const body of ['<svg/>',' \ufeff <html><script>x()</script></html>'])assert.throws(()=>classify([...new TextEncoder().encode(body)]));
  assert.equal(classify([...new TextEncoder().encode('\nordinary text')]),'text/plain');
});
test('valid PBF framing wins over a coincidental whitespace and less-than text prefix',()=>{
  const body=glyphFile([glyphStack(undefined,'x'.repeat(37))]);
  assert.equal(body.length,62);assert.deepEqual([...body.slice(0,5)],[10,60,10,37,120]);
  assert(new TextDecoder('utf-8',{fatal:true}).decode(body).trimStart().startsWith('<'));
  assert.equal(classifyMapPbf(body),glyphMime);assert.equal(classifyResourceBytes(body),glyphMime);
  for(const text of ['<html><script>1</script></html>','\n<svg xmlns="http://www.w3.org/2000/svg"/>',
    '<?xml version="1.0"?><document/>',' \ufeff <HTML></HTML>']){
    const bytes=new TextEncoder().encode(text);
    assert.equal(classifyMapPbf(bytes),undefined);
    assert.throws(()=>classifyResourceBytes(bytes),{code:'decode-failed'});
  }
});
test('glyph core required fields, ranges, dimensions and SDF bitmap length are bounded',()=>{
  const bitmap=Array((2+6)*(3+6)).fill(0);
  assert.equal(classifyResourceBytes(glyphFile([glyphStack([glyph(65,2,3,bitmap)])])),glyphMime);
  assert.equal(classifyResourceBytes(glyphFile([glyphStack([glyph(65,4096,4096)])])),glyphMime);
  const cases=[glyphFile([glyphStack([glyph(65,4097,0)])]),glyphFile([glyphStack([glyph(65,2,3,[0])])]),
    glyphFile([glyphStack([glyph(256)])]),glyphFile([glyphStack([glyph(),glyph()])]),glyphFile([glyphStack([scalar(1,65)])]),
    glyphFile([glyphStack([join(glyph(),scalar(1,65))])]),glyphFile([glyphStack([glyph()],'name','1-256')]),
    glyphFile([glyphStack([glyph()],'name','0-256')]),glyphFile([glyphStack([glyph()],'name','0-255\n')]),glyphFile([glyphStack([glyph()],'','0-255')]),
    glyphFile([join(string(1,'fixture'),data(2,[255]),data(3,glyph()))]),glyphFile([join(glyphStack(),scalar(8,0))])];
  for(const bytes of cases)assert.notEqual(classifyMapPbf(bytes),glyphMime);
  const exact=Array.from({length:256},(_,id)=>glyph(id));assert.equal(classifyResourceBytes(glyphFile([glyphStack(exact)])),glyphMime);
  assert.equal(classifyMapPbf(glyphFile([glyphStack([...exact,glyph()])])),undefined);
  assert.equal(classifyResourceBytes(glyphFile(Array(16).fill(glyphStack()))),glyphMime);
  assert.equal(classifyMapPbf(glyphFile(Array(17).fill(glyphStack()))),undefined);
});
test('MVT required layer fields, unique names, values, tags and geometry framing are checked',()=>{
  const invalid=[tile([layer([],undefined,1)]),tile([layer([],undefined,2,0)]),tile([layer(),layer()]),
    tile([layer([feature([0])])]),tile([layer([feature([1,0])])]),tile([layer([feature([0,1])])]),
    tile([layer([feature([0,0,0,0])])]),tile([layer([feature([],[],4)])]),
    tile([layer([join(scalar(3,1),data(4,[128]))])]),tile([layer([scalar(3,1)])]),
    tile([layer([data(4,[9,2,4])])]),tile([layer([],undefined,2,4096,['key'],[join(string(1,'x'),scalar(7,1))])]),
    tile([layer([],undefined,2,4096,[],[data(1,[255])])]),tile([join(layer(),scalar(15,2))]),tile([join(layer(),scalar(16,0))])];
  for(const bytes of invalid)assert.equal(classifyMapPbf(bytes),undefined);
  const maximum='x'.repeat(MAP_PBF_LIMITS.stringBytes);
  assert.equal(classifyResourceBytes(tile([layer([],undefined,2,4096,[],[string(1,maximum)])])),tileMime);
  assert.equal(classifyMapPbf(tile([layer([],undefined,2,4096,[],[string(1,maximum+'x')])])),undefined);
  assert.equal(classifyResourceBytes(tile(Array.from({length:256},(_,i)=>layer([],'layer'+i)))),tileMime);
  assert.equal(classifyMapPbf(tile(Array.from({length:257},(_,i)=>layer([],'layer'+i)))),undefined);
  assert.equal(classifyResourceBytes(tile([layer([join(scalar(1,0xffffffffffffffffn),scalar(3,1),data(4,[9,2,4]))])])),tileMime);
  // Structural MIME classification does not claim that a guest renderer accepts command semantics.
  assert.equal(classifyResourceBytes(tile([layer([feature([], [0])])])),tileMime);
});
test('wire lengths, overflow, groups, truncation and shared CPU budgets fail closed',()=>{
  for(const bytes of [[10,128],[10,255,255,255,255,16],[10,100,1],[11,12],...Array.from({length:glyphFile().length-1},(_,i)=>[...glyphFile().slice(0,i)])]){
    assert.equal(classifyMapPbf(new Uint8Array(bytes)),undefined);
  }
  const reader=new MapPbfReader(new Uint8Array(Array(MAP_PBF_LIMITS.fields+1).fill([8,0]).flat()));
  for(let i=0;i<MAP_PBF_LIMITS.fields;i++){reader.field();reader.uint32();}assert.throws(()=>reader.field());
  const packed=new MapPbfReader(new Uint8Array(MAP_PBF_LIMITS.varints+1));
  for(let i=0;i<MAP_PBF_LIMITS.varints;i++)packed.uint32();assert.throws(()=>packed.uint32());
  assert.throws(()=>new MapPbfReader(new Uint8Array([255,255,255,255,255,255,255,255,255,2])).uint64());
});
