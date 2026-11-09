export function uint(value:number|bigint):number[] {
  let number=BigInt(value);const output:number[]=[];
  do{const byte=Number(number&127n);number>>=7n;output.push(byte+(number?128:0));}while(number);
  return output;
}
export const join=(...parts:readonly number[][]):number[]=>parts.flat();
export const scalar=(field:number,value:number|bigint):number[]=>[...uint(field*8),...uint(value)];
export const data=(field:number,value:readonly number[]):number[]=>[...uint(field*8+2),...uint(value.length),...value];
export const string=(field:number,value:string):number[]=>data(field,[...new TextEncoder().encode(value)]);
export function glyph(id=65,width=0,height=0,bitmap:number[]=[]):number[] {
  return join(scalar(1,id),...(bitmap.length?[data(2,bitmap)]:[]),scalar(3,width),scalar(4,height),scalar(5,0),scalar(6,0),scalar(7,1));
}
export function glyphStack(glyphs:number[][]=[glyph()],name='Fixture',range='0-255'):number[] {
  return join(string(1,name),string(2,range),...glyphs.map(value=>data(3,value)));
}
export const glyphFile=(stacks:number[][]=[glyphStack()]):Uint8Array<ArrayBuffer>=>new Uint8Array(join(...stacks.map(value=>data(1,value))));
export function feature(tags:number[]=[0,0],geometry:number[]=[9,2,4],type=1):number[] {
  return join(scalar(1,1),data(2,join(...tags.map(uint))),scalar(3,type),data(4,join(...geometry.map(uint))));
}
export function layer(features:number[][]=[feature()],name='fixture',version=2,extent=4096,keys=['name'],values=[string(1,'fixture')]):number[] {
  return join(string(1,name),...features.map(value=>data(2,value)),...keys.map(value=>string(3,value)),
    ...values.map(value=>data(4,value)),scalar(5,extent),scalar(15,version));
}
export const tile=(layers:number[][]=[layer()]):Uint8Array<ArrayBuffer>=>new Uint8Array(join(...layers.map(value=>data(3,value))));
