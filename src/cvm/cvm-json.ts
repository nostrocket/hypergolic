import type {JsonValue} from '../routing/routing-contract.ts';

/** Exact JSON serialization semantics, copied/frozen before any asynchronous admission. */
export function captureCvmJson(value:unknown):JsonValue{
  let nodes=0,bytes=0;
  const ancestors=new Set<object>();
  const bad=():never=>{throw new Error('Invalid CVM JSON');};
  const count=(amount:number)=>{bytes+=amount;if(bytes>32*1024)bad();};
  const string=(text:string)=>{if(text.length>32*1024)bad();count(new TextEncoder().encode(JSON.stringify(text)).length);};
  const own=(object:object,key:PropertyKey)=>Object.prototype.hasOwnProperty.call(object,key);
  function clone(input:unknown,depth:number):JsonValue{
    if(++nodes>2048||depth>32)return bad();
    if(input===null){count(4);return null;}
    if(typeof input==='boolean'){count(input?4:5);return input;}
    if(typeof input==='number'){
      if(!Number.isFinite(input))return bad();count(JSON.stringify(input).length);return Object.is(input,-0)?0:input;
    }
    if(typeof input==='string'){string(input);return input;}
    if(typeof input!=='object'||ancestors.has(input))return bad();
    ancestors.add(input);const descriptors=Object.getOwnPropertyDescriptors(input);let result:JsonValue;
    if(Array.isArray(input)){
      if(Object.getPrototypeOf(input)!==Array.prototype||input.length>2048||Reflect.ownKeys(descriptors).length!==input.length+1)return bad();
      count(2+Math.max(0,input.length-1));
      result=Object.freeze(Array.from({length:input.length},(_,index)=>{
        const item=descriptors[String(index)];
        return item&&own(item,'value')&&item.enumerable?clone(item.value,depth+1):bad();
      }));
    }else{
      if(Object.getPrototypeOf(input)!==Object.prototype)return bad();
      const keys=Reflect.ownKeys(descriptors);count(2+Math.max(0,keys.length-1));
      result=Object.freeze(Object.fromEntries(keys.map(key=>{
        const item=descriptors[key as string];
        if(typeof key!=='string'||!item||!own(item,'value')||!item.enumerable)return bad();
        string(key);count(1);return[key,clone(item.value,depth+1)];
      })));
    }
    ancestors.delete(input);return result;
  }
  const captured=clone(value,0);
  if(bytes!==new TextEncoder().encode(JSON.stringify(captured)).length)return bad();
  return captured;
}
