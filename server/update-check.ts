/* App updates: the top bar shows "Update" when GitHub has a newer CreativeField release than this install.
   States and transitions: Pad (hidden -> available -> dialog -> updating -> restart | failed).
   "Update now" only runs on the user's own computer, in a clean git clone of the public repository, and runs three
   fixed commands; every other install gets the Download ZIP steps instead. The hosted app never offers updates. */
import {execFile} from "node:child_process";
import {existsSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {promisify} from "node:util";
import type {FastifyInstance,FastifyRequest} from "fastify";
import {guestsOnly} from "./cloud-keys";
import {HttpError} from "./auth";

const run=promisify(execFile);
const REPO="rhymeas/Creativefield";
const CHECK_EVERY=6*60*60*1000;
const root=process.cwd();

export type UpdateInfo={current:string;latest?:string;available:boolean;notesUrl?:string;title?:string;canSelfUpdate:boolean;reason?:string};

/** "0.10.1" > "0.9.3": numeric parts, a leading "v" ignored, missing parts count as 0. */
export function newer(latest:string,current:string):boolean{
  const parts=(v:string)=>v.replace(/^v/i,"").split(/[.+-]/).slice(0,3).map(p=>Number.parseInt(p,10)||0);
  const a=parts(latest),b=parts(current);
  for(let i=0;i<3;i++){if((a[i]??0)!==(b[i]??0))return (a[i]??0)>(b[i]??0);}
  return false;
}

const currentVersion=()=>{try{return String(JSON.parse(readFileSync(join(root,"package.json"),"utf8")).version??"0.0.0");}catch{return "0.0.0";}};

/** Why this install cannot update itself, or undefined when it can. */
async function selfUpdateBlocker():Promise<string|undefined>{
  if(!existsSync(join(root,".git")))return "This copy came from a ZIP. Download the new ZIP to update.";
  try{await run("git",["--version"],{cwd:root});}catch{return "Git is not installed here. Download the new ZIP to update.";}
  const origin=await run("git",["remote","get-url","origin"],{cwd:root}).then(r=>r.stdout,()=>"");
  if(!origin.toLowerCase().includes(REPO.toLowerCase()))return "This copy is not a clone of the CreativeField repository. Download the new ZIP to update.";
  try{
    const {stdout:dirty}=await run("git",["status","--porcelain","--untracked-files=no"],{cwd:root});
    if(dirty.trim())return "This copy has local changes. Save them elsewhere, then update.";
    return undefined;
  }catch{return "Git could not read this copy. Download the new ZIP to update.";}
}

let cache:{at:number;info:UpdateInfo}|undefined;
async function check(force=false):Promise<UpdateInfo>{
  const current=currentVersion();
  if(!force&&cache&&Date.now()-cache.at<CHECK_EVERY&&cache.info.current===current)return cache.info;
  let info:UpdateInfo={current,available:false,canSelfUpdate:false};
  try{
    const response=await fetch(`https://api.github.com/repos/${REPO}/releases/latest`,{headers:{accept:"application/vnd.github+json","user-agent":"CreativeField-update-check"},signal:AbortSignal.timeout(8000)});
    if(response.ok){
      const release=await response.json() as {tag_name?:string;name?:string;html_url?:string};
      const latest=String(release.tag_name??"").replace(/^v/i,"");
      if(latest&&newer(latest,current)){
        const reason=await selfUpdateBlocker();
        info={current,latest,available:true,notesUrl:release.html_url,title:release.name,canSelfUpdate:!reason,reason};
      }else info={current,latest:latest||undefined,available:false,canSelfUpdate:false};
    }
  }catch{/* offline or rate limited: stay quiet, try again next time */}
  cache={at:Date.now(),info};
  return info;
}

const LOCAL=new Set(["127.0.0.1","::1","::ffff:127.0.0.1"]);
const local=(request:FastifyRequest)=>LOCAL.has(request.ip);

let updating=false;
export async function updateRoutes(app:FastifyInstance){
  app.get("/api/v1/app-update",async()=>guestsOnly()?{current:currentVersion(),available:false,canSelfUpdate:false}:check());
  app.post("/api/v1/app-update",async request=>{
    if(guestsOnly()||!local(request))throw new HttpError(403,"Updates run only in the app on your own computer.");
    const info=await check(true);
    if(!info.available)return {state:"current",current:info.current};
    if(!info.canSelfUpdate)throw new HttpError(409,info.reason??"This copy cannot update itself.");
    if(updating)throw new HttpError(409,"An update is already running.");
    updating=true;
    const npm=process.platform==="win32"?"npm.cmd":"npm";
    try{
      for(const [cmd,args] of [["git",["pull","--ff-only","origin","main"]],[npm,["install"]],[npm,["run","build"]]] as [string,string[]][]){
        await run(cmd,args,{cwd:root,maxBuffer:1<<26,shell:process.platform==="win32"&&cmd===npm,timeout:15*60*1000});
      }
      cache=undefined;
      return {state:"restart",latest:info.latest};
    }catch(error){
      const out=String((error as {stderr?:string;stdout?:string}).stderr||(error as {stdout?:string}).stdout||(error as Error).message).trim().split("\n").slice(-6).join("\n");
      throw new HttpError(500,`The update stopped: ${out}`);
    }finally{updating=false;}
  });
}
