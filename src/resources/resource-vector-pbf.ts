import {MapPbfReader, MAP_PBF_LIMITS, invalidPbf} from './resource-pbf-wire.ts';
/** MVT2 core structure. Commands, ring topology and rendering remain guest decoder responsibilities. */
function value(reader:MapPbfReader):void {
  if(reader.done)return invalidPbf();const field=reader.field();
  if(field.number===1){reader.require(field.wire,2);reader.text();}
  else if(field.number===2 || field.number===3){reader.require(field.wire,field.number===2?5:1);reader.skip(field.wire);}
  else if(field.number>=4 && field.number<=6){reader.require(field.wire,0);reader.uint64();}
  else if(field.number===7){reader.require(field.wire,0);if(reader.uint32()>1)return invalidPbf();}
  else return invalidPbf();
  if(!reader.done)invalidPbf();
}
function feature(reader:MapPbfReader,keys:number,values:number):void {
  const seen=new Set<number>(),attributes=new Set<number>();let tag=0,type:number|undefined,geometry=false;
  while(!reader.done) {
    const field=reader.field();
    if(field.number===1){if(seen.has(1))return invalidPbf();seen.add(1);reader.require(field.wire,0);reader.uint64();}
    else if(field.number===2)reader.packed(field.wire,index=>{
      if(tag++%2===0){if(index>=keys || attributes.has(index))return invalidPbf();attributes.add(index);}
      else if(index>=values)return invalidPbf();
    });
    else if(field.number===3){if(type!==undefined)return invalidPbf();reader.require(field.wire,0);type=reader.uint32();}
    else if(field.number===4){geometry=true;reader.packed(field.wire,()=>{});}
    else return invalidPbf();
  }
  if(type===undefined || type>3 || !geometry || tag%2)invalidPbf();
}
function layer(reader:MapPbfReader):string {
  const source=reader.replay(),seen=new Set<number>();let name:string|undefined,version=0,extent=0,keys=0,values=0;
  while(!reader.done) {
    const field=reader.field();
    if(field.number===1 || field.number===5 || field.number===15){if(seen.has(field.number))return invalidPbf();seen.add(field.number);}
    if(field.number===1){reader.require(field.wire,2);name=reader.text(1024);}
    else if(field.number===2){reader.require(field.wire,2);reader.data();}
    else if(field.number===3){reader.require(field.wire,2);reader.text();keys++;}
    else if(field.number===4){reader.require(field.wire,2);value(reader.message());values++;}
    else if(field.number===5 || field.number===15){reader.require(field.wire,0);const number=reader.uint32();if(field.number===5)extent=number;else version=number;}
    else return invalidPbf();
  }
  if(!name || version!==2 || !extent)return invalidPbf();
  while(!source.done) {
    const {number,wire}=source.field();
    if(number===2)feature(source.message(),keys,values);else source.skip(wire);
  }
  return name;
}
export function validateVectorPbf(reader:MapPbfReader):void {
  const names=new Set<string>();
  while(!reader.done) {
    const {number,wire}=reader.field();
    if(number!==3 || names.size>=MAP_PBF_LIMITS.layers)return invalidPbf();reader.require(wire,2);
    const name=layer(reader.message());if(names.has(name))return invalidPbf();names.add(name);
  }
  if(!names.size)invalidPbf();
}
