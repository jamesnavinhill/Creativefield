import {useEffect,useRef,useState} from "react";
import type {CapabilityManifestV2} from "../capabilities/types";
import {isEffectClips} from "../capabilities/tasks";
import {VIDEO_REFRAME_ID} from "../capabilities/video-reframe";
import {finishStepsOf} from "../capabilities/finish-steps";
import {workspacePath,type Asset,type Call} from "./api";
import type {BoardRender} from "./storyboard-state";

export type FeedKind="video"|"image";
/** Preparation copies and intermediate steps that never belong in a feed or library. */
const PREPARATION_KEYS=["libraryHidden","editorDocumentBitmap","fpsPrepare","videoPrepare","sourceLinkedMask","maskNormalization","cleanSource","posePreviewFrame","posePreview","replaceAnchorFrame","videoProbeSource","blockout","intermediate"];
const preparation=(asset:Asset)=>PREPARATION_KEYS.some(key=>asset.metadata?.[key]!==undefined);
/** Masks and segmentation helpers are working files for a run, never library results. */
const workingMask=(asset:Asset)=>{
  if(asset.media_type==="mask"||asset.metadata?.purpose==="mask"||asset.metadata?.kind==="mask")return true;
  const capability=String((asset.metadata?.generation as {capabilityId?:unknown}|undefined)?.capabilityId??"");
  return /(?:^|[-_])(mask|segment)(?:[-_]|$)|segment/i.test(capability)||/mask|segment/i.test(asset.name);
};
/** True for files that belong under Runs (masks, preparation copies, intermediate steps), not in Assets. */
export const isRunWorkingAsset=(asset:Asset)=>preparation(asset)||workingMask(asset);
/** Files that are a step after a result (upscaling, interpolation, trim, join) are Runs, not end results. */
const FINISH_STEP=/(upscale|esrgan|recavsr|seedvr2|interpolation|video-trim|concat|nvidia-vfx|reframe)/i;
/** Uploaded or saved working pictures (blockouts, layout tests, selection guides) never count as results. */
const WORKING_NAME=/(^|[-_ ])(block|blockout|layout|previs|storyboard|probe|selection|precision|first[-_ ]frame|test|pasted|reference|guide|mask|segment|upscale)([-_ .]|$)|^edit[-_]/i;
/** The end result that belongs in Assets: not a preparation file, not a mask, not a finish step. */
export const isEndResultAsset=(asset:Asset)=>{
  if(isRunWorkingAsset(asset))return false;
  const capability=String((asset.metadata?.generation as {capabilityId?:unknown}|undefined)?.capabilityId??"");
  if(capability&&FINISH_STEP.test(capability))return false;
  /* A run's own output, or a Keep text copy of one, is a result whatever its file is called: with the default Upscale
     finish every image-to-video file is named "hyperflow-upscale_000NN_", and the name rule hid all of them. The name
     rule is for uploaded or saved working files, which carry no producing run. */
  if(capability||asset.metadata?.keepText)return true;
  if(WORKING_NAME.test(asset.name))return false;
  return true;
};
/** Include library files once, including additional outputs from a multi-image run. */
export function libraryFeedAssets(assets:Asset[],kind:FeedKind,represented:Set<string>,hiddenCapabilities?:Set<string>):Asset[]{
  const seen=new Set<string>();
  return assets.filter(asset=>{
    if(asset.media_type!==kind||isRunWorkingAsset(asset)||represented.has(asset.id))return false;
    const generation=asset.metadata?.generation as {capabilityId?:unknown;upscale?:unknown}|undefined;
    /* A finish output belongs to its result card (with the comparison); it is not a second library entry. */
    if(generation?.upscale)return false;
    const capability=String(generation?.capabilityId??"");
    if(capability&&hiddenCapabilities?.has(capability))return false;
    /* The same bytes stay one entry, however often a tool links or copies them. */
    const key=asset.sha256||asset.id;
    if(seen.has(key))return false;
    seen.add(key);
    return true;
  });
}
/** Runs whose workflow only makes an intermediate step stay out of the result galleries. */
export function feedVisibleRuns<T extends {capability_id:string}>(runs:T[],catalogue:ReadonlyArray<{id:string;feedHidden?:boolean}>):T[]{
  const hidden=new Set(catalogue.filter(manifest=>manifest.feedHidden).map(manifest=>manifest.id));
  return hidden.size?runs.filter(run=>!hidden.has(run.capability_id)):runs;
}
/** Which shared feed a workflow's results belong to, by what it makes. */
export function feedKind(manifest:Pick<CapabilityManifestV2,"outputs">|undefined):FeedKind|undefined{
  const type=manifest?.outputs?.[0]?.type;
  return type==="video"?"video":type==="image"?"image":undefined;
}
/** The shared feed of one kind: every workflow that makes it, and the workflows of the app that is open. */
export type FeedScope={kind:FeedKind;capabilities:string[];current?:string[];/** The mode each workflow makes things in, shown on its tiles. */modes?:Record<string,string>;/** Workflows whose outputs are preparation steps, never feed members. */hiddenCapabilities?:Set<string>;/** Enhance step packs → their row, for the card's finishing words. */finishSteps?:Record<string,string>};
const MODES:Record<string,string>={t2v:"Text to video",i2v:"Image to video",flf2v:"First and last frame",video:"Video",motion:"Motion transfer",replacement:"Replace",enhance:"Enhanced",finishing:"Restyle",image:"Image",canvas:"Image edit",identity:"Character","3d":"3D",audio:"Audio"};
/** The mode a workflow makes things in, in plain words. */
export const feedMode=(manifest:Pick<CapabilityManifestV2,"id"|"category">)=>manifest.id===VIDEO_REFRAME_ID?"Reframe":isEffectClips(manifest.id)?"Effects":MODES[manifest.category]??manifest.category;
export function feedScope(catalogue:CapabilityManifestV2[],kind:FeedKind,current?:string[]):FeedScope{
  const members=catalogue.filter(m=>feedKind(m)===kind&&!m.feedHidden);
  return {kind,capabilities:members.map(m=>m.id),current,modes:Object.fromEntries(members.map(m=>[m.id,feedMode(m)])),hiddenCapabilities:new Set(catalogue.filter(m=>m.feedHidden).map(m=>m.id)),finishSteps:finishStepsOf(catalogue)};
}

export type FeedFilm={id:string;assetId:string|null;state:string;createdAt:string;board:string};
type Board={id:string;name:string;project_id:string};
type Still={child_run_id?:string|null};
const finished=new Map<string,string[]>(); // render id -> its shots' run ids, kept once the render is done

/** Storyboards and keyframe animations add only their finished film to the video feed; the runs of their single
 * shots and frames are hidden from both feeds. Read every 10 s while open. */
export function useStoryboardFeed(call:Call,workspaceId:string,projectId:string,authorized:boolean,enabled:boolean,version:number){
  const [state,setState]=useState<{hidden:Set<string>;films:FeedFilm[]}>({hidden:new Set(),films:[]});
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;if(!authorized||!enabled)return;let timer:ReturnType<typeof setTimeout>;
    async function read(){
      try{
        const boards=(await call<Board[]>(workspacePath(workspaceId,"storyboards"))).filter(b=>b.project_id===projectId);
        const hidden=new Set<string>(),films:FeedFilm[]=[];
        for(const board of boards){
          const [renders,stills]=await Promise.all([call<BoardRender[]>(workspacePath(workspaceId,`storyboards/${board.id}/renders`)),call<Still[]>(workspacePath(workspaceId,`storyboards/${board.id}/stills`)).catch(()=>[] as Still[])]);
          for(const still of stills)if(still.child_run_id)hidden.add(still.child_run_id);
          for(const render of renders){
            let runIds=finished.get(render.id);
            if(!runIds){const detail=await call<BoardRender>(workspacePath(workspaceId,`storyboard-renders/${render.id}`));runIds=(detail.shots??[]).flatMap(s=>s.child_run_id?[s.child_run_id]:[]);if(render.output_asset_id||/fail|cancel/.test(render.state))finished.set(render.id,runIds);}
            for(const id of runIds)hidden.add(id);
            films.push({id:render.id,assetId:render.output_asset_id,state:render.state,createdAt:render.created_at,board:board.name});
          }
        }
        /* The same boards and films keep the old state, so the feed is not drawn again every ten seconds. */
        if(alive.current)setState(old=>old.hidden.size===hidden.size&&[...hidden].every(id=>old.hidden.has(id))&&JSON.stringify(old.films)===JSON.stringify(films)?old:{hidden,films});
      }catch{/* the feed keeps what it last read */}
      finally{if(alive.current)timer=setTimeout(read,10000);}
    }
    void read();return()=>{alive.current=false;clearTimeout(timer);};
  },[call,workspaceId,projectId,authorized,enabled,version]);
  return state;
}
