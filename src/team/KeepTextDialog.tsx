import {useEffect,useRef,useState} from "react";
import {Button,CropHandles,Dialog,Meta,Notice,StatusText} from "../ds";
import {assetUrl,workspacePath,type Call} from "./api";

type Box={x:number;y:number;w:number;h:number};
/* States (Pad DOC-1343): editing -> working -> done (closes, the new clip is in the feed) | failed (reason shown,
   frame kept, Try again). Cancel leaves every state; nothing changes until Keep text is pressed. */
type Phase={kind:"editing"}|{kind:"working"}|{kind:"failed";error:string};
const MIN=0.02;
const clamp=(v:number,lo:number,hi:number)=>Math.min(hi,Math.max(lo,v));

/** Keep text: the person frames the lettering on the video's start picture; the server tracks that clean lettering
    onto every frame and saves a new clip beside the original. The frame is the DS crop frame (CropHandles). */
export function KeepTextDialog({open,workspaceId,runId,pictureId,call,onClose,onDone}:{open:boolean;workspaceId:string;runId:string;pictureId:string;call:Call;onClose:()=>void;onDone:()=>void}){
  /* The frame in fractions of the picture: it starts in the middle, where a chest print usually is. */
  const [box,setBox]=useState<Box>({x:0.4,y:0.42,w:0.2,h:0.12});
  const [phase,setPhase]=useState<Phase>({kind:"editing"});
  const [view,setView]=useState({x:0,y:0,w:0,h:0});
  const stage=useRef<HTMLDivElement>(null),drag=useRef<{handle:string;x:number;y:number;start:Box}|null>(null);
  useEffect(()=>{if(open)setPhase({kind:"editing"});},[open]);
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
  const working=phase.kind==="working";
  async function keep(){
    setPhase({kind:"working"});
    try{
      await call(workspacePath(workspaceId,`runs/${runId}/keep-text`),"POST",{boxes:[[box.x,box.y,box.x+box.w,box.y+box.h]]});
      onDone();onClose();
    }catch(error){setPhase({kind:"failed",error:(error as Error).message});}
  }
  return <Dialog open={open} title="Keep text" onClose={()=>{if(!working)onClose();}}
    footer={<><Button variant="ghost" disabled={working} onClick={onClose}>Cancel</Button><Button variant="primary" disabled={working} onClick={()=>void keep()}>{working?"Keeping the text…":phase.kind==="failed"?"Try again":"Keep text"}</Button></>}>
    {phase.kind==="failed"&&<Notice inline priority={20} title="The text could not be kept" details={phase.error}>Your video is unchanged. Adjust the frame and try again.</Notice>}
    <Meta>Frame the lettering that should stay sharp. The video keeps it from the start picture in every frame; your original stays as it is.</Meta>
    <div ref={stage} className="cf-keeptext"
      onPointerDown={event=>{if(working||event.target!==event.currentTarget.querySelector("img"))return;const rect=(event.target as HTMLElement).getBoundingClientRect();const cx=(event.clientX-rect.left)/rect.width,cy=(event.clientY-rect.top)/rect.height;setBox(b=>({...b,x:clamp(cx-b.w/2,0,1-b.w),y:clamp(cy-b.h/2,0,1-b.h)}));}}>
      <img src={assetUrl(workspaceId,pictureId)} alt="Start picture" draggable={false} onLoad={measure}/>
      {view.w>0&&<CropHandles box={{x:box.x*1000,y:box.y*1000,w:box.w*1000,h:box.h*1000}} viewport={view} width={1000} height={1000}
        onStart={(handle,event)=>{if(working)return;event.currentTarget.setPointerCapture(event.pointerId);drag.current={handle,x:event.clientX,y:event.clientY,start:box};}}
        onMove={event=>{const d=drag.current;if(!d||!view.w)return;setBox(resize(d.handle,d.start,(event.clientX-d.x)/view.w,(event.clientY-d.y)/view.h));}}
        onEnd={()=>{drag.current=null;}} onCancel={()=>{drag.current=null;}}
        onNudge={(handle,dx,dy)=>setBox(b=>resize(handle,b,dx/1000*4,dy/1000*4))}/>}
    </div>
    {working&&<StatusText tone="active">Following the lettering through every frame. This takes about as long as the clip, times ten.</StatusText>}
  </Dialog>;
}
