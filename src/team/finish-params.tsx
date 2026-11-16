/* The finishing rows shared by Enhance video and Create Video: Upscale (Fast, Best) and Smooth motion
   (2x), one parameter button per row. Which pack stands behind an option is the manifests'
   `finishStep` (src/capabilities/finish-steps.ts); nothing here names a pack. */
import {useState,type ReactNode} from "react";
import {Film,Maximize2} from "lucide-react";
import {Meta,ParamButton,Params} from "../ds";
import {chainLine,type FinishChoice,type FinishRow,type PlannedStep} from "../capabilities/finish-steps";

const ROW_TITLES:Record<string,string>={upscale:"Upscale",interpolate:"Smooth motion"};
/** The button shows the row in one short word, so two buttons fit side by side. */
const ROW_SHORT:Record<string,string>={interpolate:"Smooth"};
const ROW_ICONS:Record<string,typeof Maximize2>={upscale:Maximize2,interpolate:Film};
const OFF="off";
const optionLabel=(option:string)=>option===OFF?"Off":option.charAt(0).toUpperCase()+option.slice(1);

/** The person's choice per row, remembered under `storageKey`. `initial` is a first visit's choice. */
export function useFinishChoice(storageKey:string,initial:()=>FinishChoice):[FinishChoice,(step:string,option:string)=>void]{
  const [choice,setChoiceState]=useState<FinishChoice>(()=>{
    try{const saved=JSON.parse(localStorage.getItem(storageKey)??"null") as FinishChoice|null;if(saved&&typeof saved==="object")return saved;}catch{/* A fresh choice below. */}
    return initial();
  });
  const setChoice=(step:string,option:string)=>setChoiceState(old=>{
    const next={...old,[step]:option};
    try{localStorage.setItem(storageKey,JSON.stringify(next));}catch{/* The choice still holds for this visit. */}
    return next;
  });
  return [choice,setChoice];
}

/** The rows as parameter buttons, plus what the chosen chain means: its order and any stand-in pack.
 *  The sound needs no line: the chain's last step takes the source clip's sound back (server/execution.ts). */
export function FinishParams({rows,choice,steps,onChange,disabled,lead}:{rows:FinishRow[];choice:FinishChoice;steps:PlannedStep[];onChange:(step:string,option:string)=>void;disabled?:boolean;/** A button that sits first in the same row, such as the model's own Upscale finish, so the two share one line. */lead?:ReactNode}){
  const standIn=steps.filter(step=>step.fallback);
  return <>
    <Params>{lead}{rows.map(row=>{
      const Icon=ROW_ICONS[row.step]??Maximize2,value=choice[row.step]&&row.options.some(option=>option.option===choice[row.step])?choice[row.step]!:OFF;
      const options=[{value:OFF,label:"Off"},...row.options.map(option=>({value:option.option,label:optionLabel(option.option)}))];
      return <ParamButton key={row.step} disabled={disabled} title={ROW_TITLES[row.step]??optionLabel(row.step)} icon={<Icon size={16}/>}
        label={`${ROW_SHORT[row.step]??ROW_TITLES[row.step]??optionLabel(row.step)}: ${optionLabel(value)}`} value={value} options={options} onChange={next=>onChange(row.step,next)}/>;
    })}</Params>
    {steps.length>1&&<Meta>{`Runs ${chainLine(steps)}`}</Meta>}
    {standIn.length>0&&<Meta>{`${standIn.map(step=>step.label).join(", ")} stands in: the preferred pack is not ready here`}</Meta>}
  </>;
}
