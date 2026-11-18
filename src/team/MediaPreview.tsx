import {useState} from "react";
import {Meta} from "../ds";

/** A failed preview never removes the stored asset or its actions. Remount to retry. */
export function MediaPreview({src,kind,alt="",lazy=false,controls=false,onUnavailable,small}:{src:string;kind:"image"|"video";alt?:string;lazy?:boolean;controls?:boolean;onUnavailable?:()=>void;/** A small copy to show in a tile; `src` (the full file) takes over if it cannot be read. */small?:string}){
  const [failed,setFailed]=useState(false),[full,setFull]=useState(false);
  const fail=()=>{if(small&&!full){setFull(true);return;}setFailed(true);onUnavailable?.();};
  if(failed)return <Meta>Preview unavailable</Meta>;
  return kind==="image"
    ? <img draggable={false} decoding="async" src={small&&!full?small:src} alt={alt} loading={lazy?"lazy":undefined} onError={fail}/>
    : <video draggable={false} muted={!controls} controls={controls} playsInline preload="metadata" src={src} aria-label={alt||undefined} onError={fail}/>;
}
