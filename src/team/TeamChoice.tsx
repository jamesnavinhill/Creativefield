import {useCallback,useEffect,useState,type ReactNode} from "react";
import {ChevronRight} from "lucide-react";
import {Button,ChoiceDialog,MediaPickerDialog,Meta,ModelCard,Pill,Row,type ChoiceOption,type OptionStatus} from "../ds";
import {friendlyMediaName} from "./media-names";
import "./pick.css";
import {splitModel} from "./menu-groups";
import {cardLoop} from "./reels";

/** Every workspace's model card says what it does in large type and which model does it in the small line under it:
    "HyperFlow H3 Flash text to video" becomes "Text to video" over "HyperFlow H3 Flash · Local ComfyUI". */
export function modelCardText(display:string,subtitle?:string):{title:string;subtitle:string}{
  const {model,rest}=splitModel(display);
  /* The small line names models, never whole workflow titles: "FLUX 3 Klein text to image" there becomes "FLUX 3 Klein". */
  const parts=(subtitle??"Local ComfyUI").split(" · ").map(part=>splitModel(part).model??part);
  const small=[...(model&&rest?[model]:[]),...parts].filter((part,i,all)=>all.indexOf(part)===i).join(" · ");
  return {title:model&&rest?rest:display,subtitle:small};
}

export type TeamChoiceOption={value:string;label:string;note?:string;disabled?:boolean;status?:OptionStatus;detail?:ReactNode;/** The picture or symbol at the start of the box. */icon?:ReactNode;preview?:{src:string;video?:boolean}};
/** Existing studio triggers and selection surfaces; never a browser-native select. `prefix` writes the quiet label before the value; turn it off when the value is the whole action. `size` is the pill height (`lg` for a full label like "Choose from library"). */
/** A choice as the design system's box: its own symbol, or its small picture. */
const toChoice=(o:TeamChoiceOption):ChoiceOption=>({value:o.value,label:o.label,note:o.note,status:o.status,detail:o.detail,disabled:o.disabled,icon:o.icon??(o.preview?(o.preview.video?<video src={o.preview.src} muted playsInline preload="metadata"/>:<img src={o.preview.src} alt="" loading="lazy"/>):undefined)});
export function TeamChoice({label,display,value,options,onChange,disabled=false,variant="row",size="md",prefix=true,subtitle,image,video,openSignal=0,onLoadMore,loadingMore=false,loadMoreError,hideTrigger=false,upload}:{label:string;display:string;value:string;options:TeamChoiceOption[];onChange:(value:string)=>void;disabled?:boolean;variant?:"row"|"model"|"pill";size?:"md"|"lg";prefix?:boolean;subtitle?:string;image?:string;video?:string;openSignal?:number;onLoadMore?:()=>void;loadingMore?:boolean;loadMoreError?:string;hideTrigger?:boolean;/** This device as the first tile of the picker. */upload?:{accept:string;kinds?:Array<"image"|"video"|"audio">;onFile:(file:File)=>void}}){
  const [open,setOpen]=useState(false),close=useCallback(()=>setOpen(false),[]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  useEffect(()=>{if(openSignal>0&&!disabled)setOpen(true);},[openSignal,disabled]);
  const choose=(option:TeamChoiceOption)=>{if(disabled||option.disabled)return;onChange(option.value);close();};
  // Media choices are picked by looking at them: a picture grid with plain names instead of a list of file names.
  const visual=options.length>0&&options.every(o=>o.preview);
  return <>
    {!hideTrigger&&(variant==="model"?<ModelCard {...modelCardText(display,subtitle)} image={image} video={cardLoop(value,display)??video} onChange={disabled?undefined:()=>setOpen(true)}/>:variant==="pill"?<Pill quiet size={size} type="button" disabled={disabled} aria-label={label} onClick={()=>setOpen(true)}>{prefix&&<span className="ds-pill__prefix">{label}</span>}{display}{size!=="lg"&&<ChevronRight size={14}/>}</Pill>:<Row label={label} display={display} disabled={disabled} onClick={()=>setOpen(true)}/>)}
    {visual||!options.length
      ?<MediaPickerDialog open={open&&!disabled} title={label} onClose={close} selected={value} upload={upload?{...upload,onFile:file=>{upload.onFile(file);close();}}:undefined}
        items={options.map(o=>({id:o.value,src:o.preview?.src??"",video:o.preview?.video,label:friendlyMediaName(o.label),disabled:o.disabled,info:<>{o.label}{o.note&&<><br/>{o.note}</>}</>}))}
        onPick={id=>{const option=options.find(o=>o.value===id);if(option)choose(option);}}
        onLoadMore={onLoadMore} loadingMore={loadingMore} loadMoreError={loadMoreError} emptyText={onLoadMore?"Load more files to find compatible resources.":"Add a compatible resource to this workspace first."}/>
      :<ChoiceDialog open={open&&!disabled} title={label} value={value} options={options.map(toChoice)} onPick={picked=>{const option=options.find(o=>o.value===picked);if(option)choose(option);}} onClose={close} footer={onLoadMore?<>{loadMoreError&&<div role="status"><Meta>{loadMoreError}</Meta></div>}<Button variant="secondary" disabled={loadingMore} onClick={onLoadMore}>{loadingMore?"Loading…":loadMoreError?"Try again":"Load more"}</Button></>:undefined}/>}
  </>;
}
