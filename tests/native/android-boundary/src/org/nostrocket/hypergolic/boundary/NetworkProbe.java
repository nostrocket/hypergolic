package org.nostrocket.hypergolic.boundary;

/** Privileged test stimulus in the real opaque guest; no guest policy replacement. */
final class NetworkProbe {
  private NetworkProbe() {}
  static final String SCRIPT = """
    value=await(async()=>{
      const config=JSON.parse(command.wire),target=config.target;
      const violations=[];
      const observe=e=>violations.push({directive:e.effectiveDirective,uri:e.blockedURI});
      addEventListener('securitypolicyviolation',observe);
      const denied={},elements=[];
      const outcome=start=>new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('No observable denial')),3000);
        start(result=>{clearTimeout(timer);resolve(result);});
      });
      try {
        try {await fetch(target+'/fetch');denied.fetch=false;}catch {denied.fetch=true;}
        denied.xhr=await outcome(done=>{const xhr=new XMLHttpRequest();xhr.onload=()=>done(false);xhr.onerror=()=>done(true);xhr.open('GET',target+'/xhr');xhr.send();});
        denied.websocket=await outcome(done=>{try {const ws=new WebSocket(target.replace('http:','ws:')+'/websocket');ws.onopen=()=>{ws.close();done(false);};ws.onerror=()=>done(true);}catch {done(true);}});
        denied.image=await outcome(done=>{const image=new Image();image.onload=()=>done(false);image.onerror=()=>done(true);image.src=target+'/image';});
        denied.script=await outcome(done=>{const script=document.createElement('script');elements.push(script);script.onload=()=>done(false);script.onerror=()=>done(true);script.src=target+'/script';document.head.append(script);});
        denied.css=await outcome(done=>{const link=document.createElement('link');elements.push(link);link.rel='stylesheet';link.onload=()=>done(false);link.onerror=()=>done(true);link.href=target+'/css';document.head.append(link);});
        denied.worker=await outcome(done=>{try {const worker=new Worker(target+'/worker');worker.onmessage=()=>{worker.terminate();done(false);};worker.onerror=e=>{e.preventDefault();worker.terminate();done(true);};}catch {done(true);}});
        const originalLocation=location.href,form=document.createElement('form');elements.push(form);form.method='POST';form.action=target+'/form';document.body.append(form);form.submit();
        const popup=window.open(target+'/popup','_blank');denied.popup=popup===null;if(popup)popup.close();
        await new Promise(resolve=>setTimeout(resolve,250));
        return {denied,violations,form:{action:form.action,method:form.method,connected:form.isConnected,locationUnchanged:location.href===originalLocation}};
      } finally {removeEventListener('securitypolicyviolation',observe);for(const element of elements)element.remove();}
    })();
    """;
}
