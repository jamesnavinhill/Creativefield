import {Button,Notice} from "../ds";

/** The server's install job (server/model-install.ts). */
export type InstallJob={capabilityId:string;workerId:string;title:string;state:"installing"|"restart"|"restarting"|"done"|"failed"|"stopped";error?:string;
  items:{kind:"model"|"node";name:string;bytes:number;done:number;state:"queued"|"working"|"done"|"failed";error?:string}[]};

const gb=(bytes:number)=>`${(bytes/1e9).toFixed(1)} GB`;

/** One line in the problem bar while a tool's files install: what is happening, how far, and the one way out.
    No progress bar (DS): the words carry the amount. */
export function InstallNotice({job,onStop,onRetry,onCheck}:{job:InstallJob;onStop:()=>void;onRetry:()=>void;onCheck:()=>void}){
  const total=job.items.reduce((sum,item)=>sum+item.bytes,0),done=job.items.reduce((sum,item)=>sum+Math.min(item.done,item.bytes),0);
  const current=job.items.find(item=>item.state==="working");
  if(job.state==="installing")return <Notice consequence priority={35} title={current?.kind==="node"?`Installing nodes · ${current.name}`:`Installing models · ${total?`${gb(done)} of ${gb(total)}`:"starting"}`} actions={<Button variant="secondary" onClick={onStop}>Stop</Button>}
    details={job.items.map(item=>`${item.state==="done"?"done":item.state==="working"?"now":"next"}  ${item.name}${item.bytes?` (${gb(item.bytes)})`:""}`).join("\n")}>
    {`For ${job.title}${current?` · now ${current.name}`:""}. You can keep working; it continues if you close this tool.`}
  </Notice>;
  if(job.state==="restarting")return <Notice consequence priority={35} title="Restarting ComfyUI">The new nodes load when ComfyUI is back; this takes about a minute.</Notice>;
  if(job.state==="restart")return <Notice consequence priority={35} title="Restart ComfyUI to finish" actions={<Button variant="secondary" onClick={onCheck}>Check again</Button>}>{job.error??"Close the ComfyUI window and start it again so it loads the new nodes."}</Notice>;
  if(job.state==="stopped")return <Notice consequence priority={35} title="Install stopped" actions={<Button variant="secondary" onClick={onRetry}>Continue</Button>}>Downloaded parts are kept, so it continues where it stopped.</Notice>;
  return <Notice consequence priority={35} title="Install stopped" actions={<Button variant="secondary" onClick={onRetry}>Try again</Button>} details={job.items.filter(item=>item.error).map(item=>`${item.name}: ${item.error}`).join("\n")}>{job.error??"Something went wrong while installing."} Downloaded parts are kept.</Notice>;
}
