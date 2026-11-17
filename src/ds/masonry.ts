import {useLayoutEffect,useRef,type RefObject} from "react";

/** Grid row height in px: a tile spans as many rows as it is tall, so every gap between tiles is exact. */
export const MASONRY_ROW=1;

/** Where the next tile goes: the columns whose tallest is lowest, starting below that tallest column so a
 *  tile spanning two columns never lies on top of the tile in the taller one. `heights` are column heights in rows. */
export function placeTile(heights:readonly number[],span:number):{column:number;top:number}{
 const width=Math.min(span,heights.length);let column=0,top=Number.POSITIVE_INFINITY;
 for(let i=0;i+width<=heights.length;i++){const tallest=Math.max(...heights.slice(i,i+width));if(tallest<top){top=tallest;column=i;}}
 return {column,top};
}

type MasonryOptions={
 /** Columns each child takes (default 1 each). */
 span?:(cells:HTMLElement[])=>number[];
 /** Runs before measuring, for example to give a loading tile its neighbour's shape. */
 prepare?:(cells:HTMLElement[])=>void;
 /** Leave the grid's column gap below every tile; off when the tiles carry their own bottom space. */
 gap?:boolean;
 enabled?:boolean;
};

/** Measured masonry for a CSS grid with 1px rows (`grid-auto-rows: var(--mosaic-row)`, children `align-self: start`):
 *  the children go, in feed order, into the column whose bottom is highest. The feed therefore reads left to
 *  right and columns grow evenly. CSS `columns` fills one column top to bottom first, which stacks neighbours
 *  of the same shape into one column. Re-runs whenever a child changes size or the children change. */
export function useMasonry(ref:RefObject<HTMLElement|null>,cols:number,options:MasonryOptions={}){
 const latest=useRef(options);latest.current=options;
 const enabled=options.enabled!==false;
 useLayoutEffect(()=>{const el=ref.current;if(!el||!enabled||typeof ResizeObserver==="undefined")return;
  let frame=0;
  const layout=()=>{frame=0;const cells=Array.from(el.children) as HTMLElement[],{span,prepare,gap}=latest.current;
   prepare?.(cells);
   const spans=span?.(cells)??cells.map(()=>1),below=gap?parseFloat(getComputedStyle(el).columnGap)||0:0,heights=new Array<number>(cols).fill(0);
   /* Width first: a tile's height follows its width, so its column span is set before it is measured. */
   cells.forEach((cell,index)=>{cell.style.gridRow="";cell.style.gridColumn=`span ${Math.min(cols,spans[index]??1)}`;});
   for(const [index,cell] of cells.entries()){
    const width=Math.min(cols,spans[index]??1),rows=Math.max(1,Math.ceil((cell.getBoundingClientRect().height+below)/MASONRY_ROW)),{column,top}=placeTile(heights,width);
    cell.style.gridColumn=`${column+1} / span ${width}`;cell.style.gridRow=`${top+1} / span ${rows}`;
    for(let i=column;i<column+width;i++)heights[i]=top+rows;
   }};
  /* Next frame, or after 200 ms when frames are paused (a background tab), so a tab coming back is already in order. */
  let timer=0;
  const run=()=>{if(frame)cancelAnimationFrame(frame);clearTimeout(timer);layout();};
  const schedule=()=>{if(frame)return;frame=requestAnimationFrame(run);timer=window.setTimeout(run,200);};
  const sizes=new ResizeObserver(schedule);
  const watch=()=>{sizes.disconnect();for(const cell of Array.from(el.children))sizes.observe(cell);schedule();};
  const feed=new MutationObserver(watch);feed.observe(el,{childList:true});
  /* The first placement happens before paint, so tiles never flash stacked on top of each other. */
  watch();if(frame)run();
  return()=>{feed.disconnect();sizes.disconnect();if(frame)cancelAnimationFrame(frame);clearTimeout(timer);};
 },[ref,cols,enabled]);
}
