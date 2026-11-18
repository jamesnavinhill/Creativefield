import {useEffect,useRef,useState} from "react";
import {Button,Checkbox,CropHandles,Dialog,Meta,Notice,StatusText} from "../ds";
import {assetUrl,workspacePath,type Call} from "./api";
import {capabilityReadiness} from "../capabilities/readiness";
import type {CapabilityManifestV2,WorkerInventory} from "../capabilities/types";

type Box={x:number;y:number;w:number;h:number};
type Frame=Box&{id:string;label:string;on:boolean};
/* States (Pad DOC-1343): finding (SAM 3 looks for flat prints) -> editing (frames shown, each can be switched off,
   moved and resized) -> working -> done (closes, the new clip is in the feed) | failed (reason, frames kept, Try again).
   Finding never blocks: without SAM 3 or a hit, one frame starts in the middle. Cancel leaves every state. */
type Phase={kind:"finding"}|{kind:"editing"}|{kind:"working"}|{kind:"failed";error:string};
const MIN=0.02;
const clamp=(v:number,lo:number,hi:number)=>Math.min(hi,Math.max(lo,v));

/* Only flat things: lettering and printed marks. "words" takes both lines of a print ("text" only took the first). Heads, faces, eyes and hands turn in depth, so a flat paste would
   ghost (tested on the Squarehead head); they belong to the 3D consistency plan. "icon" and "logo" also
   return the whole head, so a hit must stay small: prints were 0.05-0.24 % of the frame, the head 1.9-4.3 %. */
const FIND=[{prompt:"words",label:"Text"},{prompt:"printed logo",label:"Print"},{prompt:"icon",label:"Icon"}] as const;
const MAX_AREA=0.015,MIN_AREA=0.0002;
const SEGMENT_ID="sam3-image-segment";

type Worker={id:string;origin:string;kind?:string;enabled?:boolean;inventory?:WorkerInventory};
type RunState={id:string;state:string;output_ids:string[]};

/** Boxes (fractions) around the separate areas of a mask picture; nearby pieces of one print are joined. */
async function maskBoxes(url:string):Promise<Box[]>{
  const img=await new Promise<HTMLImageElement>((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=url;});
  const W=Math.min(512,img.naturalWidth),H=Math.round(img.naturalHeight*W/img.naturalWidth);
  const canvas=document.createElement("canvas");canvas.width=W;canvas.height=H;
  const ctx=canvas.getContext("2d");if(!ctx)return [];
  ctx.drawImage(img,0,0,W,H);const data=ctx.getImageData(0,0,W,H).data;
  const seen=new Uint8Array(W*H),boxes:Array<[number,number,number,number,number]>=[];
  for(let start=0;start<W*H;start++){
    if(seen[start]||data[start*4]<128)continue;
    let x0=W,y0=H,x1=0,y1=0,count=0;const stack=[start];seen[start]=1;
    while(stack.length){const p=stack.pop()!,x=p%W,y=(p-x)/W;count++;x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);
      for(const q of [p-1,p+1,p-W,p+W])if(q>=0&&q<W*H&&!seen[q]&&Math.abs((q%W)-x)<=1&&data[q*4]>=128){seen[q]=1;stack.push(q);}}
    if(count>4)boxes.push([x0,y0,x1+1,y1+1,count]);
  }
  /* Join pieces closer than one line height (two words of one print). */
  let merged=true;
  while(merged){merged=false;
    for(let i=0;i<boxes.length&&!merged;i++)for(let j=i+1;j<boxes.length&&!merged;j++){
      const a=boxes[i],b=boxes[j],gap=Math.max(a[3]-a[1],b[3]-b[1]);
      if(a[0]-gap<b[2]&&b[0]-gap<a[2]&&a[1]-gap<b[3]&&b[1]-gap<a[3]){boxes[i]=[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3]),a[4]+b[4]];boxes.splice(j,1);merged=true;}
    }}
  return boxes.map(([x0,y0,x1,y1])=>{const pad=0.25*(y1-y0);return {x:clamp((x0-pad)/W,0,1),y:clamp((y0-pad)/H,0,1),w:clamp((x1-x0+2*pad)/W,MIN,1),h:clamp((y1-y0+2*pad)/H,MIN,1)};})
    .filter(b=>b.w*b.h>=MIN_AREA&&b.w*b.h<=MAX_AREA);
}
const overlap=(a:Box,b:Box)=>{const w=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x),h=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);return w>0&&h>0?w*h/Math.min(a.w*a.h,b.w*b.h):0;};

/** Runs SAM 3 on the picture for each flat word and returns the frames it suggests. The runs are keyed by video and
    word, so opening the dialog again reuses the masks; SAM 3 is feedHidden, so nothing shows up in the feeds. */
async function findFrames(call:Call,workspaceId:string,projectId:string,runId:string,pictureId:string,onWaiting:(waiting:boolean)=>void,stopped:()=>boolean):Promise<Frame[]>{
  const catalogue=await call<CapabilityManifestV2[]>(workspacePath(workspaceId,"catalogue"),"GET");
  const segment=catalogue.find(item=>item.id===SEGMENT_ID);if(!segment)return [];
  /* Only a worker that has SAM 3's nodes and model: another one would accept the run and leave it queued. */
  const workers=(await call<Worker[]>(workspacePath(workspaceId,"workers"),"GET"))
    .filter(w=>w.enabled!==false&&w.kind!=="cloud"&&w.inventory?.online&&capabilityReadiness(segment,"local",w.inventory).state==="ready");
  if(!workers.length)return [];
  const frames:Frame[]=[];
  for(const find of FIND){
    let run:RunState|undefined;
    for(const worker of workers){
      run=await call<RunState>(workspacePath(workspaceId,"runs"),"POST",{projectId,workerId:worker.id,idempotencyKey:`keep-text-find:${runId}:${find.prompt}:${worker.id}`,capabilityId:SEGMENT_ID,version:segment.version,routeId:"local",
        inputs:{source_image:pictureId},controls:{prompt:find.prompt,threshold:0.35,individual_masks:false},audioPolicy:"mute"}).catch(()=>undefined);
      if(run)break;
    }
    /* SAM 3 takes about a second; "queued" means the graphics card is busy with another render, so it waits for it
       (up to 15 minutes) and says so, instead of giving up. The person can frame it themselves meanwhile. */
    for(let tries=0;run&&run.state!=="succeeded"&&tries<900&&!stopped();tries++){
      if(/fail|cancel/.test(run.state))break;
      onWaiting(run.state==="queued"&&tries>=3);
      await new Promise(resolve=>setTimeout(resolve,1000));
      run=await call<RunState>(workspacePath(workspaceId,`runs/${run.id}`),"GET").catch(()=>run);
    }
    onWaiting(false);
    if(stopped())return frames;
    if(run?.state!=="succeeded"||!run.output_ids[0])continue;
    for(const box of await maskBoxes(assetUrl(workspaceId,run.output_ids[0])).catch(()=>[] as Box[]))
      if(!frames.some(frame=>overlap(frame,box)>0.5))frames.push({...box,id:`${find.prompt}-${frames.length}`,label:`${find.label} ${frames.filter(f=>f.label.startsWith(find.label)).length+1}`,on:true});
  }
  return frames;
}

/** Keep text: SAM 3 suggests frames around flat prints on the video's start picture; the person switches them off,
    moves or resizes them (DS CropHandles); the server keeps that clean lettering in every frame of a new clip. */
export function KeepTextDialog({open,workspaceId,projectId,runId,pictureId,call,onClose,onDone}:{open:boolean;workspaceId:string;projectId:string;runId:string;pictureId:string;call:Call;onClose:()=>void;onDone:()=>void}){
  const [frames,setFrames]=useState<Frame[]>([]);
  const [active,setActive]=useState(0);
  const [phase,setPhase]=useState<Phase>({kind:"finding"});
  const [found,setFound]=useState(0),[waiting,setWaiting]=useState(false),[placed,setPlaced]=useState(true);
  const skip=useRef(false);
  /* Without a suggestion nothing is framed yet: the person clicks the lettering first, so Keep text never pastes the
     picture over a spot nobody chose. */
  const manual=(list:Frame[])=>{setFound(list.length);setPlaced(list.length>0);setWaiting(false);
    setFrames(list.length?list:[{id:"manual",label:"Frame",on:true,x:0.4,y:0.42,w:0.14,h:0.09}]);setActive(0);setPhase({kind:"editing"});};
  const [view,setView]=useState({x:0,y:0,w:0,h:0});
  const stage=useRef<HTMLDivElement>(null),drag=useRef<{index:number;handle:string;x:number;y:number;start:Box}|null>(null);
  useEffect(()=>{
    if(!open)return;let live=true;skip.current=false;setPhase({kind:"finding"});
    findFrames(call,workspaceId,projectId,runId,pictureId,w=>{if(live)setWaiting(w);},()=>!live||skip.current).catch(()=>[] as Frame[]).then(list=>{
      if(!live||skip.current)return;manual(list);
    });
    return()=>{live=false;};
  },[open,runId]);
  const measure=()=>{const img=stage.current?.querySelector("img");if(img)setView({x:img.offsetLeft,y:img.offsetTop,w:img.clientWidth,h:img.clientHeight});};
  useEffect(()=>{if(!open)return;const observer=new ResizeObserver(measure);if(stage.current)observer.observe(stage.current);return()=>observer.disconnect();},[open]);

  const resize=(handle:string,start:Box,dx:number,dy:number):Box=>{
    let {x,y,w,h}=start;
    if(handle.includes("w")){const nx=clamp(x+dx,0,x+w-MIN);w+=x-nx;x=nx;}
    if(handle.includes("e"))w=clamp(w+dx,MIN,1-x);
    if(handle.includes("n")){const ny=clamp(y+dy,0,y+h-MIN);h+=y-ny;y=ny;}
    if(handle.includes("s"))h=clamp(h+dy,MIN,1-y);
    return {x,y,w,h};
  };
  const update=(index:number,box:Box)=>setFrames(list=>list.map((frame,i)=>i===index?{...frame,...box}:frame));
  const chosen=frames.filter(frame=>frame.on);
  const busy=phase.kind==="working"||phase.kind==="finding";
  async function keep(){
    setPhase({kind:"working"});
    try{
      await call(workspacePath(workspaceId,`runs/${runId}/keep-text`),"POST",{boxes:chosen.slice(0,4).map(f=>[f.x,f.y,f.x+f.w,f.y+f.h])});
      onDone();onClose();
    }catch(error){setPhase({kind:"failed",error:(error as Error).message});}
  }
  return <Dialog open={open} title="Keep text" onClose={()=>{if(phase.kind!=="working")onClose();}}
    footer={<><Button variant="ghost" disabled={phase.kind==="working"} onClick={onClose}>Cancel</Button>{phase.kind==="finding"&&<Button variant="secondary" onClick={()=>{skip.current=true;manual([]);}}>Frame it myself</Button>}<Button variant="primary" disabled={busy||!chosen.length||!placed} onClick={()=>void keep()}>{phase.kind==="working"?"Keeping the text…":phase.kind==="failed"?"Try again":"Keep text"}</Button></>}>
    {phase.kind==="failed"&&<Notice inline priority={20} title="The text could not be kept" details={phase.error}>Your video is unchanged. Adjust the frames and try again.</Notice>}
    {phase.kind==="finding"?<StatusText tone="active">{waiting?"Waiting for the graphics card: another render is running. Lettering is found as soon as it is free.":"Looking for lettering and prints…"}</StatusText>
      :<Meta>{found?"These prints stay sharp in every frame. Switch off what should move freely, or adjust a frame.":"No lettering was found. Click the lettering that should stay sharp, then adjust the frame."} Your original stays as it is.</Meta>}
    {frames.length>1&&<div className="cf-keeptext__frames">{frames.map((frame,index)=><Checkbox key={frame.id} checked={frame.on} disabled={busy} onChange={on=>{setFrames(list=>list.map((f,i)=>i===index?{...f,on}:f));if(on)setActive(index);}}>{frame.label}</Checkbox>)}</div>}
    <div ref={stage} className="cf-keeptext"
      onPointerDown={event=>{if(busy||event.target!==event.currentTarget.querySelector("img"))return;const rect=(event.target as HTMLElement).getBoundingClientRect();const cx=(event.clientX-rect.left)/rect.width,cy=(event.clientY-rect.top)/rect.height;const f=frames[active];if(f){update(active,{...f,x:clamp(cx-f.w/2,0,1-f.w),y:clamp(cy-f.h/2,0,1-f.h)});setPlaced(true);}}}>
      <img src={assetUrl(workspaceId,pictureId)} alt="Start picture" draggable={false} onLoad={measure}/>
      {view.w>0&&placed&&frames.map((frame,index)=>frame.on&&<CropHandles compact handles={index===active} key={frame.id} box={{x:frame.x*1000,y:frame.y*1000,w:frame.w*1000,h:frame.h*1000}} viewport={view} width={1000} height={1000}
        onStart={(handle,event)=>{if(busy)return;setActive(index);event.currentTarget.setPointerCapture(event.pointerId);drag.current={index,handle,x:event.clientX,y:event.clientY,start:frame};}}
        onMove={event=>{const d=drag.current;if(!d||!view.w)return;update(d.index,resize(d.handle,d.start,(event.clientX-d.x)/view.w,(event.clientY-d.y)/view.h));}}
        onEnd={()=>{drag.current=null;}} onCancel={()=>{drag.current=null;}}
        onNudge={(handle,dx,dy)=>{setActive(index);update(index,resize(handle,frame,dx/1000*4,dy/1000*4));}}/>)}
    </div>
    {phase.kind==="working"&&<StatusText tone="active">Following the lettering through every frame. This takes about as long as the clip, times ten.</StatusText>}
  </Dialog>;
}
