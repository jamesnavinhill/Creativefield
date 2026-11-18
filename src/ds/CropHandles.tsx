import type {PointerEventHandler} from "react";

const HANDLES=[
  {id:"nw",x:0,y:0,label:"Resize crop from top left corner"},
  {id:"n",x:.5,y:0,label:"Resize crop from top edge"},
  {id:"ne",x:1,y:0,label:"Resize crop from top right corner"},
  {id:"e",x:1,y:.5,label:"Resize crop from right edge"},
  {id:"se",x:1,y:1,label:"Resize crop from bottom right corner"},
  {id:"s",x:.5,y:1,label:"Resize crop from bottom edge"},
  {id:"sw",x:0,y:1,label:"Resize crop from bottom left corner"},
  {id:"w",x:0,y:.5,label:"Resize crop from left edge"},
] as const;

const offset=(position:number)=>position===.5?"0px":`calc(${position===0?-1:1} * var(--space-3))`;

/** Screen-sized crop targets sit clear of the image and never become clipped by its bitmap. */
export function CropHandles({box,viewport,width,height,onStart,onMove,onEnd,onCancel,onNudge,compact=false,handles=true}:{
  box:{x:number;y:number;w:number;h:number};viewport:{x:number;y:number;w:number;h:number};width:number;height:number;
  /** A small frame on a picture (marking an area, not cropping it): the frame sits exactly on the area and only the
      four corners are handles, small and on the corners, so they never cover what is framed. */
  compact?:boolean;
  /** Off: only the frame (another frame is being edited). */
  handles?:boolean;
  onStart:(handle:string,event:React.PointerEvent<HTMLElement>)=>void;
  onMove:PointerEventHandler<HTMLElement>;onEnd:PointerEventHandler<HTMLElement>;onCancel:()=>void;
  onNudge:(handle:string,dx:number,dy:number)=>void;
}){
  const left=viewport.x+box.x/width*viewport.w,top=viewport.y+box.y/height*viewport.h,w=box.w/width*viewport.w,h=box.h/height*viewport.h;
  const shown=!handles?[]:compact?HANDLES.filter(handle=>handle.id.length===2):HANDLES;
  return <div className="ds-crophandles" role="group" aria-label="Crop handles" data-compact={compact||undefined}>
    <span className="ds-cropframe" aria-hidden style={{left,top,width:w,height:h}}/>
    {shown.map(handle=><button type="button" key={handle.id} aria-label={handle.label} className="ds-crophandle" data-handle={handle.id}
      style={{left:viewport.x+(box.x+box.w*handle.x)/width*viewport.w,top:viewport.y+(box.y+box.h*handle.y)/height*viewport.h,"--crop-offset-x":compact?"0px":offset(handle.x),"--crop-offset-y":compact?"0px":offset(handle.y)} as React.CSSProperties}
      onPointerDown={event=>{event.stopPropagation();onStart(handle.id,event);}} onPointerMove={onMove} onPointerUp={onEnd} onPointerCancel={onCancel} onLostPointerCapture={onCancel}
      onKeyDown={event=>{const delta=event.shiftKey?10:1;if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key))return;event.preventDefault();onNudge(handle.id,event.key==="ArrowLeft"?-delta:event.key==="ArrowRight"?delta:0,event.key==="ArrowUp"?-delta:event.key==="ArrowDown"?delta:0);}}/>)}
  </div>;
}
