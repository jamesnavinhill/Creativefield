/* Black Forest Labs with the workspace's own key (BYOK,). Same FLUX.2 Pro models and
   controls as the Comfy Router route, sent straight to api.bfl.ai with the x-key header.
   Results are signed delivery.*.bfl.ai URLs valid for ten minutes; the runner downloads them at once. */
import {ROUTER_CONTRACTS,type RouterModel} from '../../src/capabilities/router-models';
import type {DirectAdapter,OwnedInput} from './types';
import type {Registration} from './registry';

export const BFL_PROVIDER='bfl';
export const BFL_ROUTE='bfl';
const API='https://api.bfl.ai';
/** BFL answers a job at the regional polling_url it returns; these are the hosts it may name. */
const REGIONS=['us','eu'].flatMap(z=>['',...Array.from({length:12},(_,n)=>String(n+1))].map(n=>z+n));/* api.us7.bfl.ai seen 2026-11-19 */
const POLL_ORIGINS=REGIONS.map(r=>`https://api.${r}.bfl.ai`);
/* Results come from delivery.<region>.bfl.ai (seen: delivery.us7.bfl.ai, 2026-11-19) or delivery-<region>.bfl.ai;
   BFL adds regions, so every us/eu region 1-12 in both spellings is allowed (the transport needs exact origins). */
const DELIVERY_REGIONS=['us','eu'].flatMap(z=>['',...Array.from({length:12},(_,n)=>String(n+1))].map(n=>z+n));
const DELIVERY=DELIVERY_REGIONS.flatMap(r=>[`https://delivery.${r}.bfl.ai`,`https://delivery-${r}.bfl.ai`]);
const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(v);
const endpoint=(m:RouterModel)=>`/v1/${m.model.split('/')[1]}`;
/** The remote id is `<job id>.<region>` (region empty for the global host), so polling needs no second record. */
export function remoteFor(jobId:string,pollingUrl:unknown):string{
  let region='';try{const host=new URL(String(pollingUrl)).hostname,match=/^api\.([a-z0-9]+)\.bfl\.ai$/.exec(host);if(match&&REGIONS.includes(match[1]))region=match[1];}catch{/* global host */}
  return region?`${jobId}.${region}`:jobId;
}
function pollTarget(remote:string){const [job,region]=remote.split('.');return {path:`/v1/get_result?id=${encodeURIComponent(job)}`,origin:region&&REGIONS.includes(region)?`https://api.${region}.bfl.ai`:API};}
async function base64(input:OwnedInput){const parts:Buffer[]=[];let n=0;for await(const c of await input.open()){const b=Buffer.from(c);n+=b.length;if(n>20*1024*1024)throw new Error('Reference exceeds 20 MB');parts.push(b);}return Buffer.concat(parts).toString('base64');}

/** The FLUX contracts BFL serves directly: the same models the Router route offers. */
export const BFL_CONTRACTS=ROUTER_CONTRACTS.filter(m=>m.kind==='flux'&&m.model.startsWith('bfl/flux-2'));

export function bflAdapter(m:RouterModel):DirectAdapter{
  return {id:`bfl-${m.kind}`,version:'1.0.0',provider:BFL_PROVIDER,recovery:'unsupported',cancellation:'unsupported',
    validate(i){const prompt=i.controls.prompt;if(typeof prompt!=='string'||!prompt.trim())return {valid:false,code:'invalid_input',reason:'Write a prompt.'};if(i.audioPolicy!=='mute')return {valid:false,code:'invalid_input',reason:'This sound setting is not available for this model.'};return {valid:true};},
    async estimate(){return {kind:'unknown'};},
    async prepareInputs(inputs){const p:Record<string,string>={};for(const input of inputs){if(!['image/png','image/jpeg','image/webp'].includes(input.contentType))throw new Error('Use PNG, JPEG or WebP references');p[input.role]=await base64(input);}return p;},
    async submit(i,p,context){
      const c=i.controls,images=['source_image','reference_image','reference_image_2'].filter(k=>p[k]);
      const body={prompt:String(c.prompt),width:c.width,height:c.height,seed:c.seed,output_format:'png',...Object.fromEntries(images.map((k,n)=>[n?`input_image_${n+1}`:'input_image',p[k]]))};
      try{const r=object(await context.transport.api(endpoint(m),{method:'POST',body}));if(!id(r.id))return {kind:'unknown'};
      /* The polling host only, never the address: tells which region answers this job. */
      try{console.info(`BFL job accepted; polling host ${new URL(String(r.polling_url)).hostname}`);}catch{/* no polling url */}
      return {kind:'accepted',remoteId:remoteFor(r.id,r.polling_url)};}
      catch(e){const status=(e as {status?:number}).status;return status&&[400,401,402,403,422,429].includes(status)?{kind:'rejected',code:status===401||status===403?'unauthorized':status===402?'payment_required':'rejected'}:{kind:'unknown'};}
    },
    async poll(remote,context){
      if(!id(remote))throw new Error('Invalid request ID');
      const t=pollTarget(remote),r=object(await context.transport.api(t.path,{origin:t.origin})),status=String(r.status??'');
      if(status==='Ready')return {state:'succeeded'};
      if(status==='Pending'||status==='Reasoning'||status==='Generating')return {state:'running'};
      if(/moderated/i.test(status))return {state:'failed',code:'rejected',reason:`${m.title} blocked it as sensitive content. Try another picture or prompt.`};
      if(status==='Task not found')return {state:'failed',code:'unknown',reason:'Black Forest Labs no longer knows this request. Start it again.'};
      if(status==='Error'||status==='Failed'||status==='No Card Generated')return {state:'failed',code:'rejected',reason:`${m.title} failed at Black Forest Labs. Try again or change the prompt.`};
      throw new Error('Unknown BFL status');
    },
    async cancel(){return {kind:'unsupported'};},
    async recover(){return {kind:'unsupported'};},
    async outputs(remote,context){const t=pollTarget(remote),r=object(await context.transport.api(t.path,{origin:t.origin})),url=object(r.result).sample;if(r.status!=='Ready'||typeof url!=='string')throw new Error('Missing BFL output');return [{url,mediaType:'image',contentType:'image/png'}];},
  };
}
export const bflRegistrations:Registration[]=BFL_CONTRACTS.map(m=>({qualified:true,adapter:bflAdapter(m),binding:{capabilityId:m.id,capabilityVersion:'1.0.0',routeId:BFL_ROUTE,adapterId:`bfl-${m.kind}`,adapterVersion:'1.0.0',provider:BFL_PROVIDER,model:m.model.split('/')[1],upstreamProviders:[],apiOrigins:[API,...POLL_ORIGINS],artifactOrigins:DELIVERY}}));
