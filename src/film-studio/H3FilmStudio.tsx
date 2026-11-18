import {SourceCredit,WorkflowDescription} from "../team/workflow-info";
import {lazy,Suspense,useEffect,useMemo,useRef,useState} from "react";
import {Block,Button,Dialog,EmptyState,Meta,Notice,PromptField,StatusText,Thumb,ThumbGrid} from "../ds";
import {workspacePath,type Call,type Project,type Worker,type Workspace} from "../team/api";
import {compileShotDirection,type VideoHandoff} from "../capabilities/shot-direction";
import {scanReferenceClip} from "./analysis-client";
import {shotBatches,type AnalysisScan,type ShotDecision} from "./analysis-contract";
import {shotBrief} from "./shot-brief";
import {decideShotsWithVision} from "./decision";
import {describeScene,sceneFrames,sceneLine} from "./scene-context";
import {evaluateFrame} from "./score/evaluate";
import {parseStageScore} from "./score/parse";
import {synthesizeMeasuredPlan} from "./geometry-synthesis";
import {planToScoreYaml} from "./score-build";
import {isFrameScanCacheMiss,requestGeometryBatch,scanReferenceFrames} from "./analysis-client";
import {youtubeId,youtubeSection,type YoutubeSection} from "./session";
import {analyseYoutubeVideo,captureEmbeddedPlayer,supportsTabCapture,YouTubePlayerClock} from "./youtube-capture";
import {renderShotClipFrames} from "./stage/shot-capture";
import {uploadBlockoutClip,uploadProjectAsset} from "./stage/handoff";
import type {StageScore} from "./score/schema";
import type {ShotGeometry} from "./analysis-contract";
import {clearCameraView} from "./geometry";
import "./film-studio.css";

const LegacyFilmStudio=lazy(async()=>({default:(await import("./FilmStudio")).LegacyFilmStudio}));
const StageViewport=lazy(async()=>({default:(await import("./stage/StageViewport")).StageViewport}));

export type H3FilmStudioProps={
  workspace:Workspace;
  project:Project;
  call:Call;
  canCreate:boolean;
  onOpenShotGenerator:()=>void;
  onSendToVideo?:(assetId:string,handoff?:VideoHandoff)=>void;
};

type H3Take={id:string;file:string;subfolder:string;frames?:number;poster?:string};
type H3Clip={id:string;name:string;kind?:string;seconds?:number;active?:string;takes?:H3Take[]};
type H3Project={clips?:H3Clip[]};

const projectName=(id:string)=>`cf-${id}`;
const takeOf=(clip:H3Clip)=>clip.takes?.find(take=>take.id===clip.active)??clip.takes?.[0];
const shotWords=(scan:AnalysisScan)=>{
  const lines=[`Reference analysis: ${scan.shots.length} shot${scan.shots.length===1?"":"s"}, ${scan.clip.durationSec.toFixed(1)} s.`];
  for(const decision of scan.decisions){
    const described=scan.scene?.shots.find(shot=>shot.shotIndex===decision.shotIndex)?.description;
    lines.push(`Shot ${decision.shotIndex+1}: ${decision.people} ${decision.people===1?"person":"people"}, ${decision.size} shot, ${decision.motion} camera.${described?` ${described}`:""}`);
  }
  for(const geometry of scan.geometries){
    if(geometry.quality==="estimated")continue;
    const camera=geometry.camera;
    lines.push(`Shot ${geometry.shotIndex+1}: ${Math.round(camera.lensMm)} mm, ${Math.round(camera.fovDeg)}° horizontal, camera ${camera.heightM.toFixed(1)} m high, ${Math.round(camera.pitchDeg)}° pitch, ${cameraMove(camera)}.`);
  }
  return lines.join("\n");
};
/** One previs clip holds at most 20 s at 24 fps (the blockout encoder's frame limit). */
const PREVIS_FPS=24,PREVIS_MAX_FRAMES=480;
/** The previs clip of an analysed H3 clip: every shot rendered through its measured camera, with its
 *  rebuilt set and figures, in the handoff look, joined in order so the clip cuts where the source cuts. */
async function renderPrevisFrames(score:StageScore,geometries:readonly ShotGeometry[],onProgress:(done:number,total:number)=>void){
  const frames:string[]=[];
  for(const [index,shot] of score.shots.entries()){
    const left=PREVIS_MAX_FRAMES-frames.length;
    if(left<2)break;
    const set=viewSet(geometries.find(geometry=>geometry.shotIndex===index));
    const clip=await renderShotClipFrames(score,shot.id,{fps:PREVIS_FPS,width:1280,maxFrames:left,maxDurationSec:Math.max(0.1,shot.endSec-shot.startSec),look:"handoff",set});
    frames.push(...clip.frames);
    onProgress(index+1,score.shots.length);
  }
  return frames;
}
/** The shot's set without boxes in the camera's view of its people; also cleans older cached sets. */
const viewSet=(geometry:ShotGeometry|undefined)=>geometry?.set?clearCameraView(geometry.set,{cameraHeightM:geometry.camera.heightM,personRoots:geometry.persons.flatMap(person=>person.keyframes)}):undefined;
/** Where the previs flow stands: one value, so a second run cannot start while one works. */
type PrevisState={step:"idle"}|{step:"rendering";text:string}|{step:"encoding"}|{step:"importing"}|{step:"placed";name:string;assetId:string}|{step:"failed";error:string};
/** A YouTube part analysed in place ( tab capture, no download): the link and the part to read. */
type YoutubeRun={videoId:string;section?:YoutubeSection;name:string};
const clockText=(seconds:number)=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,"0")}`;
const youtubeRunOf=(link:string):YoutubeRun|null=>{
  const videoId=youtubeId(link.trim().split(/\s+/)[0]??"");
  if(!videoId)return null;
  const section=youtubeSection(link);
  return {videoId,...(section?{section}:{}),name:`YouTube ${videoId}${section?` ${clockText(section.startSec)}–${clockText(section.endSec)}`:""}`};
};
const previsBusy=(state:PrevisState)=>state.step==="rendering"||state.step==="encoding"||state.step==="importing";

/** The measured camera move over the shot in words: stage +x is the camera's left. */
const cameraMove=(camera:AnalysisScan["geometries"][number]["camera"])=>{
  const path=camera.path??[];
  if(path.length<2)return "locked off";
  const first=path[0],last=path[path.length-1],yaw=Math.round(last.yawDeg-first.yawDeg);
  const forward=last.zM-first.zM,side=last.xM-first.xM,parts:string[]=[];
  if(Math.abs(yaw)>=1)parts.push(`pans ${Math.abs(yaw)}° ${yaw>0?"left":"right"}`);
  if(Math.abs(forward)>=0.1)parts.push(`${Math.abs(forward).toFixed(1)} m ${forward>0?"in":"out"}`);
  if(Math.abs(side)>=0.1)parts.push(`${Math.abs(side).toFixed(1)} m ${side>0?"left":"right"}`);
  return parts.length?parts.join(", "):"locked off";
};
/** What the analysis measured for one shot, as three short facts (camera, floor, people). */
const shotFacts=(scan:AnalysisScan,shotIndex:number)=>{
  const geometry=scan.geometries.find(item=>item.shotIndex===shotIndex),decision=scan.decisions.find(item=>item.shotIndex===shotIndex);
  const kind=decision?[`${decision.size} shot`,`${decision.motion} camera`]:[];
  if(!geometry)return {kind,camera:undefined,floor:undefined,people:decision?(decision.people===1?"1 person":`${decision.people} people`):undefined};
  const camera=geometry.camera,pitch=Math.round(camera.pitchDeg);
  return {
    kind,
    camera:[`${Math.round(camera.lensMm)} mm`,`${Math.round(camera.fovDeg)}° wide`,`${camera.heightM.toFixed(2)} m high`,pitch===0?"level":`${Math.abs(pitch)}° ${pitch>0?"down":"up"}`,cameraMove(camera)],
    floor:geometry.quality==="estimated"?"No floor seen, estimated from the people":geometry.floor.confidence<0.3?`Floor unsure (${Math.round(geometry.floor.confidence*100)} %), the people set the scale`:`Floor measured (${Math.round(geometry.floor.confidence*100)} %)`,
    people:geometry.persons.length?[geometry.persons.length===1?"1 person":`${geometry.persons.length} people`,...geometry.persons.map(person=>`${person.heightM.toFixed(2)} m`)].join(" · "):"No person",
  };
};

type BriefEntry={label:string;shotNumber:number;brief:ReturnType<typeof shotBrief>};

/** Film Studio, hosted on the H3 Editor custom node of the HyperFlow H3 Flash worker.
 *  CreativeField maps the open project to cf-<projectId>, and this host adds the video-analysis
 *  bridge: it reads H3 clips through the workspace API and writes the analysis back as a note. */
export function H3FilmStudio({workspace,project,call,canCreate,onOpenShotGenerator,onSendToVideo}:H3FilmStudioProps){
  const [origin,setOrigin]=useState("");
  const [worker,setWorker]=useState<Worker|null>(null);
  const [error,setError]=useState("");
  const [legacy,setLegacy]=useState(false);
  const [clips,setClips]=useState<H3Clip[]>([]);
  const [analysisOpen,setAnalysisOpen]=useState(false);
  const [scanning,setScanning]=useState(false);
  const [measuring,setMeasuring]=useState(false);
  const [analysisStage,setAnalysisStage]=useState("");
  const [scan,setScan]=useState<AnalysisScan|null>(null);
  const [scanClip,setScanClip]=useState<H3Clip|null>(null);
  const [analysisError,setAnalysisError]=useState("");
  const [noteSaved,setNoteSaved]=useState(false);
  const [briefDraft,setBriefDraft]=useState("");
  const [previs,setPrevis]=useState<PrevisState>({step:"idle"});
  const [link,setLink]=useState("");
  const [youtube,setYoutube]=useState<YoutubeRun|null>(null);
  const youtubeFrame=useRef<HTMLIFrameElement>(null);
  const captureVideo=useRef<HTMLVideoElement>(null);
  const retry=useRef<number|undefined>(undefined);
  const name=projectName(project.id);
  const briefs=useMemo<BriefEntry[]|null>(()=>{
    if(!scan)return null;
    const parsed=parseStageScore(scan.scoreYaml);
    if(!parsed.score)return null;
    const score=parsed.score;
    return score.shots.map(shot=>({label:shot.label,shotNumber:shot.shotNumber,brief:shotBrief(score,shot,{sound:true})}));
  },[scan]);
  const briefLines=useMemo(()=>{
    if(!scan)return [];
    const sceneHead=scan.scene?[sceneLine(scan.scene)]:[];
    if(briefs?.length)return [...sceneHead,...briefs.map(entry=>[`Shot ${entry.shotNumber}: ${entry.label}`, `${entry.brief.camera.move}; ${Math.round(entry.brief.camera.lensMm)} mm; ${entry.brief.camera.angle}.`, ...entry.brief.subjects.map(subject=>`${subject.label}: ${subject.side}, ${subject.framing}, ${subject.action}.`)].join("\n"))];
    return [...sceneHead,shotWords(scan)];
  },[scan,briefs]);
  const blockingScore=useMemo(()=>{
    if(!scan||!scan.decisions.length)return null;
    try{
      const windows=scan.shots.map(shot=>({shotIndex:shot.index,startSec:shot.startSec,endSec:shot.endSec}));
      const synthesized=synthesizeMeasuredPlan({decisions:scan.decisions,geometries:scan.geometries,shots:windows,title:scanClip?.name??youtube?.name??"H3 clip",aspectRatio:scan.clip.aspectRatio,cuts:scan.clip.cuts});
      const built=planToScoreYaml(synthesized.plan,{durationSec:scan.clip.durationSec,aspectRatio:scan.clip.aspectRatio,cuts:scan.clip.cuts});
      return parseStageScore(built.yaml).score??null;
    }catch{return null;}
  },[scan,scanClip,youtube]);
  useEffect(()=>{if(!scanning&&!measuring)setBriefDraft(briefLines.join("\n\n"));},[briefLines,scanning,measuring]);

  useEffect(()=>{
    let current=true;
    void call<Worker[]>(workspacePath(workspace.id,"workers")).then(workers=>{
      const local=workers.filter(item=>item.enabled&&(item as Worker&{kind?:string}).kind!=="cloud");
      const preferred=local.find(item=>/HyperFlow H3 Flash/i.test(item.name))??local.find(item=>/H3/i.test(item.name))??local[0];
      if(!current)return;
      if(!preferred){setError("No local HyperFlow H3 Flash worker is connected. Open Settings to connect it.");return;}
      setWorker(preferred);
      setOrigin(preferred.origin.replace(/\/+$/,""));
    }).catch(cause=>{if(current)setError((cause as Error).message);});
    return()=>{current=false;};
  },[call,workspace.id]);

  useEffect(()=>{
    if(!origin)return;
    let live=true;
    const load=async()=>{
      try{
        const response=await fetch(`/api/v1/workspaces/${encodeURIComponent(workspace.id)}/h3-editor/project/${encodeURIComponent(name)}`,{credentials:"same-origin"});
        if(response.status===404){if(live)retry.current=window.setTimeout(load,1500);return;}
        if(!response.ok)throw new Error("The H3 project could not be read.");
        const data=await response.json() as H3Project;
        if(live)setClips((data.clips??[]).filter(clip=>takeOf(clip)));
      }catch{/* the editor may still be creating the project; the analysis dialog retries on open */}
    };
    void load();
    return()=>{live=false;if(retry.current)window.clearTimeout(retry.current);};
  },[origin,workspace.id,name]);

  async function refreshClips(){
    const response=await fetch(`/api/v1/workspaces/${encodeURIComponent(workspace.id)}/h3-editor/project/${encodeURIComponent(name)}`,{credentials:"same-origin"});
    if(!response.ok)throw new Error("The H3 project is not ready. Open a project in the editor first.");
    const data=await response.json() as H3Project;
    const next=(data.clips??[]).filter(clip=>takeOf(clip));
    setClips(next);
    return next;
  }

  async function openAnalysis(){
    setAnalysisOpen(true);setAnalysisError("");setNoteSaved(false);
    // Each opening starts at the clip list, so another clip can be chosen; work still running stays shown.
    if(!scanning&&!measuring&&!previsBusy(previs)){setScan(null);setScanClip(null);setYoutube(null);setPrevis({step:"idle"});}
    try{await refreshClips();}catch(cause){setAnalysisError((cause as Error).message);}
  }

  async function analyse(clip:H3Clip){
    const take=takeOf(clip);
    if(!take)return;
    setScanning(true);setAnalysisError("");setScan(null);setScanClip(clip);setYoutube(null);setNoteSaved(false);setPrevis({step:"idle"});setAnalysisStage("Scanning the clip");
    try{
      const response=await fetch(`/api/v1/workspaces/${encodeURIComponent(workspace.id)}/h3-editor/media?filename=${encodeURIComponent(take.file)}&subfolder=${encodeURIComponent(take.subfolder)}`,{credentials:"same-origin"});
      if(!response.ok)throw new Error("The clip file is not available.");
      const result=await scanReferenceClip(workspace.id,await response.blob(),{filename:take.file});
      await readShots(result);
    }catch(cause){setAnalysisError((cause as Error).message);}
    finally{setScanning(false);setAnalysisStage("");}
  }

  /** The vision pass over a fresh scan: one decision per shot (people, size, motion), in batches. */
  async function readShots(result:AnalysisScan){
    setScan(result);
    if(!result.scene){
      setAnalysisStage("Describing the scene");
      const scene=await describeScene(workspace.id,result.cacheKey,sceneFrames(result));
      if(scene)setScan(current=>current?{...current,scene}:current);
    }
    if(result.pending.decisions){
      setAnalysisStage("Reading the shots");
      let decisions:ShotDecision[]=[...result.decisions];
      for(const batch of shotBatches(result.shots.length)){
        const pending=batch.indices.filter(index=>!decisions.some(decision=>decision.shotIndex===index));
        const frames:string[]=[];const indices:number[]=[];
        for(const index of pending){const shotFrames=result.shots[index]?.frames??[];const frame=shotFrames[Math.floor((shotFrames.length-1)/2)];if(frame){frames.push(frame);indices.push(index);}}
        const vision=await decideShotsWithVision(workspace.id,frames,indices);
        if(!vision)break;
        const fresh:ShotDecision[]=vision.decisions.map(({index,decision})=>({shotIndex:index,people:decision.people,size:decision.size,motion:decision.motion,needsStaging:Math.max(0,Math.round(decision.needsStaging))}));
        decisions=[...decisions,...fresh].sort((left,right)=>left.shotIndex-right.shotIndex);
        setScan(current=>current?{...current,decisions}:current);
      }
    }
  }

  /** A YouTube part: the embedded player plays only that part while this tab is shared, so cuts and
   *  keyframes are read without downloading the video (the Classic studio's path). */
  function analyseYoutube(){
    const run=youtubeRunOf(link);
    if(!run)return;
    setAnalysisError("");setScan(null);setScanClip(null);setNoteSaved(false);setPrevis({step:"idle"});
    setScanning(true);setAnalysisStage("Opening the video");setYoutube(run);
  }
  useEffect(()=>{
    if(!youtube||!scanning)return;
    const frame=youtubeFrame.current,video=captureVideo.current;
    if(!frame||!video)return;
    const clock=new YouTubePlayerClock(frame);
    clock.start();
    const controller=new AbortController();
    const signal=controller.signal;
    void analyseYoutubeVideo({
      videoId:youtube.videoId,...(youtube.section?{section:youtube.section}:{}),explicit:true,signal,iframe:frame,video,clock,fps:8,maxDurationSec:120,
      playerDuration:()=>clock.durationSec,
      probe:async request=>{try{return await scanReferenceFrames(workspace.id,request,{signal});}catch(cause){if(isFrameScanCacheMiss(cause))return null;throw cause;}},
      scanFrames:request=>scanReferenceFrames(workspace.id,request,{signal}),
      capture:options=>captureEmbeddedPlayer(options),
      supportsTabCapture:()=>supportsTabCapture(),
      runScan:async result=>{await readShots(result);},
      posterDraft:async()=>{},
      notice:notice=>setAnalysisError(notice.detail.replace(/ ?Showing the poster draft.?/,"")),
      stage:text=>setAnalysisStage(text),
      info:()=>{},
    }).catch(cause=>{if(!signal.aborted)setAnalysisError((cause as Error).message);}).finally(()=>{if(!signal.aborted){setScanning(false);setAnalysisStage("");}});
    return()=>{controller.abort();clock.stop();};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[youtube?.videoId,youtube?.section?.startSec,youtube?.section?.endSec,scanning&&!!youtube]);

  async function measureGeometry(){
    if(!scan)return;
    setMeasuring(true);setAnalysisError("");setAnalysisStage("Measuring camera, floor and blocking");
    try{
      const result=await requestGeometryBatch(workspace.id,{cacheKey:scan.cacheKey,shotIndices:scan.shots.map(shot=>shot.index)});
      setScan(current=>current?{...current,geometries:result.geometries,skips:current.skips}:current);
    }catch(cause){setAnalysisError((cause as Error).message);}
    finally{setMeasuring(false);setAnalysisStage("");}
  }

  /** Render the blocking as a grey previs clip and put it in the H3 timeline right after its source,
   *  with the shot brief as a note at its first frame. */
  async function addPrevisClip(){
    if(!scan||!(scanClip||youtube)||!blockingScore||previsBusy(previs))return;
    setPrevis({step:"rendering",text:"Rendering the stage"});
    try{
      const frames=await renderPrevisFrames(blockingScore,scan.geometries,(done,total)=>setPrevis({step:"rendering",text:`Rendering shot ${done} of ${total}`}));
      if(frames.length<2)throw new Error("The stage gave no frames to render.");
      setPrevis({step:"encoding"});
      const clipName=`Previs: ${scanClip?(scanClip.name||scanClip.id):youtube?.name??"clip"}`;
      const asset=await uploadBlockoutClip(workspace.id,project.id,{frames,fps:PREVIS_FPS,name:`${clipName}.mp4`});
      setPrevis({step:"importing"});
      const placed=await call<{clip?:string}>(workspacePath(workspace.id,`h3-editor/project/${encodeURIComponent(name)}/import`),"POST",{assetId:asset.id,projectId:project.id,name:clipName,...(scanClip?{afterClip:scanClip.id}:{})});
      const brief=briefText();
      if(placed.clip&&brief)await call(workspacePath(workspace.id,`h3-editor/project/${encodeURIComponent(name)}/notes`),"POST",{clip:placed.clip,frame:0,text:brief});
      setPrevis({step:"placed",name:clipName,assetId:asset.id});
      void refreshClips().catch(()=>{});
    }catch(cause){setPrevis({step:"failed",error:(cause as Error).message});}
  }

  /** The shot brief as the person left it (or as written), within the H3 note limit. */
  /** The prompt for Make it real: the brief if the person edited it, else every measured shot in the
   *  H3 direction format (the same compiler the classic studio hands over). */
  function videoPrompt(placePicture?:number){
    const own=briefDraft.trim();
    const generated=briefLines.join("\n\n").trim();
    if(own&&own!==generated)return own.slice(0,3900);
    const score=blockingScore;
    if(score?.shots.length)return score.shots.map(shot=>compileShotDirection({...shotBrief(score,shot,{sound:true}),...(placePicture?{placePicture}:{})})).join("\n\n").slice(0,3900);
    return briefText();
  }
  /** Phase 2 of LATER-2240: the placed previs clip goes to the Grey-block-to-video tool with the source
   *  clip's first frame as the place picture (picture 2), so the grey shapes become that place. */
  async function makeReal(assetId:string){
    if(!onSendToVideo||!scan)return;
    const take=scanClip?takeOf(scanClip):undefined;
    let placeAssetId:string|undefined;
    if(take?.poster){
      try{
        const poster=await fetch(`/api/v1/workspaces/${encodeURIComponent(workspace.id)}/h3-editor/media?filename=${encodeURIComponent(take.poster)}&subfolder=${encodeURIComponent(take.subfolder)}`,{credentials:"same-origin"});
        if(poster.ok)placeAssetId=await uploadProjectAsset(workspace.id,project.id,await poster.blob(),`Place: ${scanClip?.name||"clip"}.jpg`,"image");
      }catch{placeAssetId=undefined;}
    }
    setAnalysisOpen(false);
    onSendToVideo(assetId,{prompt:videoPrompt(placeAssetId?2:undefined),aspectRatio:scan.clip.aspectRatio,...(placeAssetId?{placeAssetId}:{})});
  }
  function briefText(){return (briefDraft.trim()||briefLines.join("\n\n")).slice(0,3900);}

  async function saveNote(){
    if(!scan||!scanClip)return;
    setAnalysisError("");
    try{
      const response=await fetch(`/api/v1/workspaces/${encodeURIComponent(workspace.id)}/h3-editor/project/${encodeURIComponent(name)}/notes`,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({clip:scanClip.id,frame:0,text:briefText()})});
      if(!response.ok)throw new Error("The note could not be saved in the H3 project.");
      setNoteSaved(true);
    }catch(cause){setAnalysisError((cause as Error).message);}
  }

  /* The editor's ... menu (scripts/h3-editor-embed.js) asks for CreativeField's own actions by message. */
  useEffect(()=>{
    const listen=(event:MessageEvent)=>{
      if(event.origin!==location.origin||typeof event.data?.type!=="string")return;
      if(event.data.type==="creativefield:analyze"&&origin)void openAnalysis();
      if(event.data.type==="creativefield:newtab")window.open(`/h3-editor/${workspace.id}/h3take/editor?project=${encodeURIComponent(name)}`,"_blank","noopener");
    };
    addEventListener("message",listen);return()=>removeEventListener("message",listen);
  });
  if(legacy)return <LegacyFilmStudio workspace={workspace} project={project} canCreate={canCreate} onOpenShotGenerator={onOpenShotGenerator} onSendToVideo={onSendToVideo}/>;
  return <div className="cf-h3studio">
    <WorkflowDescription title="Film Studio">
      <Meta>Edit clips on one timeline. Analyze clip measures a clip's camera and adds a grey-block previs of it. More actions are in the editor's ... menu next to the project name.</Meta>
      <Meta>{worker?`Runs on ${worker.name}`:"Looking for HyperFlow H3 Flash"}</Meta>
      <SourceCredit credit={{name:"H3 Editor by Igor LS",url:"https://github.com/igorls/comfyui-h3-editor",license:"GPL-3.0",what:"The timeline editor"}}/>
    </WorkflowDescription>
    {error&&<Notice priority={10} title="The H3 Editor is not reachable" actions={<Button variant="secondary" onClick={()=>{setError("");setLegacy(true);}}>Use classic studio</Button>} details={error}>The editor runs inside the HyperFlow H3 Flash worker. Connect a local worker in Settings and try again.</Notice>}
    {origin
      ?<iframe className="cf-h3studio__frame" title="H3 Editor" src={`/h3-editor/${workspace.id}/h3take/editor?project=${encodeURIComponent(name)}&cf_project=${encodeURIComponent(project.id)}&cf_name=${encodeURIComponent(project.name)}`} allow="clipboard-write; fullscreen"/>
      :!error&&<Meta>Looking for the HyperFlow H3 Flash worker…</Meta>}
    <Dialog wide={!!scan} open={analysisOpen} title={scan&&(scanClip||youtube)?`Analyze ${scanClip?(scanClip.name||"clip"):youtube?.name}`:"Analyze a clip"} onClose={()=>setAnalysisOpen(false)}
      footer={!scan&&!scanning?(youtubeRunOf(link)?<Button variant="primary" onClick={analyseYoutube}>Analyze</Button>:undefined):scan&&!scanning?<>
        {previsBusy(previs)?<StatusText tone="active">{previs.step==="rendering"?previs.text:previs.step==="encoding"?"Encoding the clip":"Adding it to the timeline"}</StatusText>
          :previs.step==="placed"?<StatusText tone="ok">{scanClip?`${previs.name} is in the timeline after its source.`:`${previs.name} is in the timeline.`}</StatusText>
          :noteSaved?<StatusText tone="ok">Saved as a note at the clip's first frame.</StatusText>:null}
        {!noteSaved&&scanClip&&<Button variant="secondary" disabled={measuring||previsBusy(previs)} onClick={()=>void saveNote()}>Save brief as note</Button>}
        {scan&&scan.pending.geometry&&scan.geometries.length===0
          ?<Button variant="primary" disabled={measuring} onClick={()=>void measureGeometry()}>{measuring?"Measuring…":"Measure camera"}</Button>
          :previs.step==="placed"
            // Phase 2 of LATER-2240: the placed previs clip goes straight to the Grey-block-to-video tool,
            // with the brief as the prompt; the character and references are added there.
            ?onSendToVideo&&<Button variant="primary" onClick={()=>void makeReal(previs.assetId)}>Make it real</Button>
            :blockingScore&&<Button variant="primary" disabled={previsBusy(previs)} onClick={()=>void addPrevisClip()}>Add previs clip</Button>}
      </>:undefined}>
      {analysisError&&<Notice priority={20} title="Analysis did not finish" details={analysisError}>The clip stays unchanged.</Notice>}
      {previs.step==="failed"&&<Notice priority={20} title="The previs clip was not added" details={previs.error} actions={<Button variant="secondary" onClick={()=>void addPrevisClip()}>Try again</Button>}>The H3 project is unchanged.</Notice>}
      {/* Start: the clips of the H3 project as pictures to choose from. */}
      {!scan&&!scanning&&<Block label="Choose a clip">
        {clips.length?<ThumbGrid label="Clips">{clips.map(clip=>{const take=takeOf(clip);return <div key={clip.id} className="cf-h3analysis__clip"><Thumb label={clip.name||clip.id} src={take?.poster?`/api/v1/workspaces/${encodeURIComponent(workspace.id)}/h3-editor/media?filename=${encodeURIComponent(take.poster)}&subfolder=${encodeURIComponent(take.subfolder)}`:undefined} info={<>{clip.name||clip.id}{clip.seconds?<><br/>{clip.seconds} s</>:null}</>} onSelect={()=>void analyse(clip)}/><Meta>{clip.name||clip.id}</Meta></div>;})}</ThumbGrid>
          :<Meta>Open a project with a rendered or imported clip in the editor first.</Meta>}
        {/* Or a part of a YouTube video: the link, then the part ("1:20-1:23"); nothing is downloaded. */}
        <PromptField label="YouTube link" value={link} onChange={setLink} placeholder="YouTube link, then the part: 1:20-1:23" compact/>
      </Block>}
      {youtube&&scanning&&<div className="fs-reference__player">
        <iframe ref={youtubeFrame} title="YouTube video" src={`https://www.youtube.com/embed/${youtube.videoId}?enablejsapi=1&playsinline=1&rel=0&modestbranding=1&iv_load_policy=3${youtube.section?`&start=${Math.floor(youtube.section.startSec)}`:""}&origin=${encodeURIComponent(window.location.origin)}`} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"/>
        <video ref={captureVideo} className="fs-reference__capture" playsInline muted aria-hidden/>
      </div>}
      {scanning&&<StatusText tone="active">{analysisStage||"Analysing the clip"}</StatusText>}
      {scan&&(scanClip||youtube)&&!scanning&&<>
        <Meta parts={[scan.shots.length===1?"1 shot":`${scan.shots.length} shots`,`${scan.clip.durationSec.toFixed(1)} s`,`${scan.clip.width}×${scan.clip.height}`]}/>
        <div className="cf-h3analysis__layout">
          {/* The stage the previs clip is rendered from: what was rebuilt, at a glance. */}
          <div className="cf-h3analysis__stage">
            {blockingScore?<Suspense fallback={null}><StageViewport score={blockingScore} frame={evaluateFrame(blockingScore,0)} view="stage" labels="off" setBlocks={viewSet(scan.geometries.find(geometry=>geometry.shotIndex===scan.shots[0]?.index))} onNavigateStart={()=>{}}/></Suspense>
              :<EmptyState plain title="No stage yet" text="Measure the camera to rebuild the place and the people."/>}
          </div>
          <div className="cf-h3analysis__facts">
            {measuring&&<StatusText tone="active">{analysisStage||"Measuring camera, floor and people"}</StatusText>}
            {scan.shots.map(shot=>{const facts=shotFacts(scan,shot.index);return <Block key={shot.index} label={scan.shots.length>1?`Shot ${shot.index+1}`:"The shot"}>
              {facts.kind.length>0&&<Meta parts={facts.kind}/>}
              {facts.camera?<Meta parts={facts.camera}/>:<Meta>Camera not measured yet</Meta>}
              {facts.floor&&<Meta>{facts.floor}</Meta>}
              {facts.people&&<Meta>{facts.people}</Meta>}
            </Block>;})}
            {scan.skips.map(skip=><Meta key={`s${skip.shotIndex}`}>{`Shot ${skip.shotIndex+1}: ${skip.reason}`}</Meta>)}
            {(scan.decisions.length>0||scan.geometries.length>0)&&<PromptField label="Shot brief" value={briefDraft} onChange={setBriefDraft} placeholder="Write the brief for this clip." compact/>}
          </div>
        </div>
      </>}
    </Dialog>
  </div>;
}
