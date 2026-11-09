/** Selected map formats only: fixed nesting, shared CPU bounds and zero-copy message views. */
export const MAP_PBF_LIMITS = Object.freeze({ fields:65_536, varints:1_000_000, stringBytes:65_536,
  stacks:16, glyphs:256, layers:256 });
export class MapPbfError extends Error {}
export const invalidPbf = (): never => { throw new MapPbfError(); };
type Budget = { fields:number; varints:number };
export class MapPbfReader {
  private at = 0;
  readonly bytes: Uint8Array;
  private readonly budget: Budget;
  constructor(bytes: Uint8Array, budget: Budget = {fields:0,varints:0}) { this.bytes=bytes; this.budget=budget; }
  get done(): boolean { return this.at === this.bytes.length; }
  uint32(): number {
    if (++this.budget.varints > MAP_PBF_LIMITS.varints) return invalidPbf();
    let value=0;
    for(let index=0;index<5;index++) {
      const byte=this.bytes[this.at++];
      if(byte===undefined || index===4 && byte>15) return invalidPbf();
      value+=(byte&127)*2**(7*index);
      if(byte<128)return value;
    }
    return invalidPbf();
  }
  uint64(): void {
    if (++this.budget.varints > MAP_PBF_LIMITS.varints) return invalidPbf();
    for(let index=0;index<10;index++) {
      const byte=this.bytes[this.at++];
      if(byte===undefined || index===9 && byte>1) return invalidPbf();
      if(byte<128)return;
    }
    return invalidPbf();
  }
  field(): Readonly<{number:number;wire:number}> {
    if(++this.budget.fields>MAP_PBF_LIMITS.fields)return invalidPbf();
    const tag=this.uint32(),number=tag>>>3,wire=tag&7;
    if(!number || wire!==0 && wire!==1 && wire!==2 && wire!==5)return invalidPbf();
    return {number,wire};
  }
  require(wire:number,expected:number):void { if(wire!==expected)invalidPbf(); }
  data(maximum=Number.MAX_SAFE_INTEGER):Uint8Array {
    const length=this.uint32();
    if(length>maximum || length>this.bytes.length-this.at)return invalidPbf();
    const view=this.bytes.subarray(this.at,this.at+length);this.at+=length;return view;
  }
  text(maximum:number=MAP_PBF_LIMITS.stringBytes):string {
    try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(this.data(maximum));}
    catch{return invalidPbf();}
  }
  message():MapPbfReader { return new MapPbfReader(this.data(),this.budget); }
  replay():MapPbfReader { return new MapPbfReader(this.bytes,this.budget); }
  skip(wire:number):void {
    if(wire===0){this.uint64();return;}
    if(wire===2){this.data();return;}
    const size=wire===1?8:wire===5?4:0;
    if(!size || size>this.bytes.length-this.at)return invalidPbf();
    this.at+=size;
  }
  packed(wire:number,consume:(value:number)=>void):void {
    if(wire===0){consume(this.uint32());return;}
    this.require(wire,2);const values=this.message();
    while(!values.done)consume(values.uint32());
  }
}
