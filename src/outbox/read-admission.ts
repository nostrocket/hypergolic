import {QUERY_LIMITS} from '../network/relay-query-contract.ts';
import {OutboxQueryError} from './query-contract.ts';

export const OUTBOX_READ_WAITING = 8;
type Release = () => void;
type Waiting = {signal:AbortSignal;check():void;cancel():void;resolve(release:Release):void;reject(error:unknown):void};
/** Shared read/planning admission. Transport owners retain their separate connection limits. */
export function createOutboxReadAdmission() {
  const waiting:Waiting[]=[];
  let active=0,pumping=false;
  function drain():void {
    if(pumping)return;
    pumping=true;
    try {
      while(active<QUERY_LIMITS.concurrent&&waiting.length){
        const job=waiting.shift()!;
        job.signal.removeEventListener('abort',job.cancel);
        try {job.check();if(job.signal.aborted)throw new OutboxQueryError('relay timeout');}
        catch(error){job.reject(error);continue;}
        active++;
        let released=false;
        job.resolve(()=>{if(released)return;released=true;active--;drain();});
      }
    } finally {pumping=false;}
  }
  return Object.freeze({
    acquire(signal:AbortSignal,check:()=>void):Promise<Release> {
      return new Promise((resolve,reject)=>{
        try {
          check();
          if(signal.aborted||waiting.length>=OUTBOX_READ_WAITING)throw new OutboxQueryError('relay timeout');
          const job:Waiting={signal,check,resolve,reject,cancel(){
            const index=waiting.indexOf(job);if(index===-1)return;
            waiting.splice(index,1);signal.removeEventListener('abort',job.cancel);
            reject(new OutboxQueryError('relay timeout'));drain();
          }};
          waiting.push(job);signal.addEventListener('abort',job.cancel,{once:true});
          if(signal.aborted)job.cancel();else drain();
        } catch(error){reject(error);}
      });
    },
  });
}
