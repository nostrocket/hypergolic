import {MapPbfReader, MAP_PBF_LIMITS, invalidPbf} from './resource-pbf-wire.ts';
/** fontnik Protocol1 core. Bitmap pixels stay opaque; dimensions and SDF border framing are checked. */
function glyph(reader:MapPbfReader,lower:number,upper:number):number {
  const seen=new Set<number>();let id=-1,width=0,height=0,bitmap=0;
  while(!reader.done) {
    const {number,wire}=reader.field();
    if(number>7 || seen.has(number))return invalidPbf();seen.add(number);
    if(number===2){reader.require(wire,2);bitmap=reader.data().length;continue;}
    reader.require(wire,0);const value=reader.uint32();
    if(number===1)id=value;
    if(number===3)width=value;
    if(number===4)height=value;
  }
  if(![1,3,4,5,6,7].every(field=>seen.has(field)) || id<lower || id>upper || width>4096 || height>4096 ||
    bitmap!==0 && bitmap!==(width+6)*(height+6))return invalidPbf();
  return id;
}
function stack(reader:MapPbfReader):void {
  let name:string|undefined,range:string|undefined;
  const source=reader.replay();let count=0;
  while(!reader.done) {
    const {number,wire}=reader.field();reader.require(wire,2);
    if(number===1){if(name!==undefined)return invalidPbf();name=reader.text(1024);}
    else if(number===2){if(range!==undefined)return invalidPbf();range=reader.text(31);}
    else if(number===3){if(++count>MAP_PBF_LIMITS.glyphs)return invalidPbf();reader.data();}
    else return invalidPbf();
  }
  if(!name || !range || !/^(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/.test(range))return invalidPbf();
  const [lower,upper]=range.split('-').map(Number) as [number,number];
  if(range!==`${lower}-${upper}` || !Number.isSafeInteger(upper) || lower%256 || upper!==lower+255 || upper>0x10ffff)return invalidPbf();
  const ids=new Set<number>();
  while(!source.done) {
    const {number,wire}=source.field();
    if(number!==3){source.skip(wire);continue;}
    const id=glyph(source.message(),lower,upper);if(ids.has(id))return invalidPbf();ids.add(id);
  }
}
export function validateGlyphPbf(reader:MapPbfReader):void {
  let count=0;
  while(!reader.done) {
    const {number,wire}=reader.field();
    if(number!==1 || ++count>MAP_PBF_LIMITS.stacks)return invalidPbf();
    reader.require(wire,2);stack(reader.message());
  }
  if(!count)invalidPbf();
}
