import {runShape} from "./run-shape";

/** The format option closest to a picture's shape; undefined when no option names a shape. */
export function nearestFormat<T>(shape:number,options:readonly T[]){
  let best:T|undefined,gap=Infinity;
  for(const option of options){
    const candidate=runShape({aspect_ratio:option});
    if(!candidate)continue;
    const distance=Math.abs(Math.log(candidate/shape));
    if(distance<gap){gap=distance;best=option;}
  }
  return best;
}

/** The named size whose shape is closest to a picture's, and among sizes of nearly that shape (within about 5 %) the one
    closest in pixel count to the current size: a 16:9 picture after the 832x480 preview stays a preview, a portrait
    default becomes the landscape of the same tier. Undefined when there are no sizes. */
export function nearestSize<S extends {width:number;height:number}>(shape:number,sizes:Record<string,S>,current?:{width?:unknown;height?:unknown}){
  const entries=Object.entries(sizes).filter(([,s])=>s.width>0&&s.height>0);
  if(!entries.length||!(shape>0))return undefined;
  const gap=(s:S)=>Math.abs(Math.log(s.width/s.height/shape));
  const best=Math.min(...entries.map(([,s])=>gap(s)));
  const area=Number(current?.width)*Number(current?.height);
  const close=entries.filter(([,s])=>gap(s)<=best+0.05);
  if(!(area>0))return close.find(([,s])=>gap(s)===best)?.[0];
  return close.reduce((a,b)=>Math.abs(Math.log(b[1].width*b[1].height/area))<Math.abs(Math.log(a[1].width*a[1].height/area))?b:a)[0];
}
