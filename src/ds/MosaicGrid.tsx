import {useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import './mosaic-grid.css';
import {useDensity} from './components';
import {usePhone} from './gestures';
import {MediaSequence} from './MediaSequence';
import {MASONRY_ROW,placeTile,useMasonry} from './masonry';

export {placeTile};

/* The shared result feed. Its columns follow the global size slider (useDensity) like every result grid; each
   tile is one column wide and as tall as its media. Tiles go, in feed order, into the column that is shortest so
   far (masonry), so columns grow evenly and no gaps open between tiles. */
const ROW=MASONRY_ROW;

/** Columns a tile took in the earlier 12-column mosaic; kept for callers, the feed itself now gives every tile one column. */
export function mosaicSpan(aspect:number,accent:0|1|2,cols:number){
 const base=aspect>=1.6?6:aspect>=1.15?5:aspect>=.85?4:3;
 const span=base+(accent===2?3:accent===1?1:0);
 return Math.min(cols,cols===12?span:Math.max(3,Math.round(span/2)));
}
/** Kept for callers: tiles no longer grow by position, the size slider sets every tile's width. */
export const mosaicAccent=(index:number):0|1|2=>index===0?2:index%5===3?1:0;

/** The shape of the finished tile closest to this one in the feed, the earlier one on a tie; undefined when none is finished. */
export function nearestShape(shapes:ReadonlyArray<number|null>,index:number){
 for(let distance=1;distance<shapes.length;distance++){const shape=shapes[index-distance]??shapes[index+distance];if(shape)return shape;}
 return undefined;
}
/** The index of the closest finished tile, so its size can be copied as well as its shape. */
function nearestFinished(shapes:ReadonlyArray<number|null>,index:number){
 for(let distance=1;distance<shapes.length;distance++){if(shapes[index-distance])return index-distance;if(shapes[index+distance])return index+distance;}
 return undefined;
}
/** Width / height of the picture or clip in a finished tile; null while it loads or while the tile is still working. */
function tileShape(cell:Element){
 if(cell.querySelector('[data-develop]'))return null;
 const media=cell.querySelector('video,img');
 if(media instanceof HTMLVideoElement)return media.videoHeight?media.videoWidth/media.videoHeight:null;
 return media instanceof HTMLImageElement&&media.naturalHeight?media.naturalWidth/media.naturalHeight:null;
}

export function MosaicGrid({label,head,children,maxColumns,square,justified}:{label:string;
 /** The feed's header line; its `end` part (a filter) is revealed on hover or focus. */
 head?:{start:ReactNode;end?:ReactNode};children:ReactNode;
 /** A denser screen may cap the feed so its pictures stay large (3 columns for the library). */
 maxColumns?:number;
 /** Pictures sit in one square frame each, so the mosaic reads as a framed gallery instead of loose shapes. */
 square?:boolean;
 /** Media-sized rows instead of measured masonry: every tile has the same height, a landscape clip simply gets wider. */
 justified?:boolean}){
 const grid=useRef<HTMLDivElement>(null),[density]=useDensity(),[narrow,setNarrow]=useState(false);
 const [tileHeight,setTileHeight]=useState(260);
 useEffect(()=>{const el=grid.current;if(!el)return;setNarrow(el.getBoundingClientRect().width<720);if(typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(([entry])=>{setNarrow(entry.contentRect.width<720);setTileHeight(Math.round(Math.min(380,Math.max(150,entry.contentRect.width/Math.max(1,cols)*0.62))));});observer.observe(el);return()=>observer.disconnect();},[]);
 const phone=usePhone(),width=narrow||phone?Math.min(2,density):density,cols=Math.max(1,Math.min(width,maxColumns??width));
 /* Placement is measured, not declared: each tile's height comes from its media, so the grid places the cells
    itself whenever a tile changes size or the feed changes, and React never sets a cell's grid position.
    Justified rows size their cells here; the masonry below goes through useMasonry. */
 useEffect(()=>{const el=grid.current;if(!el||typeof ResizeObserver==='undefined')return;
  if(!justified)return;
    /* Media-sized rows: one height for the whole feed, a landscape clip two cells wide. Measured from the
       available width so the row fills left to right and the media keeps its own framing (covered, not letterboxed). */
    const declaredShape=(cell:HTMLElement)=>{const inner=cell.firstElementChild as HTMLElement|null,media=cell.querySelector<HTMLElement>(".ds-media");return parseFloat(inner?.style.getPropertyValue("--mosaic-shape")||"")||parseFloat(media?.style.getPropertyValue("--media-shape")||"")||tileShape(cell);};
    const layout=()=>{const rect=el.getBoundingClientRect(),gap=parseFloat(getComputedStyle(el).columnGap||"16")||16,cellWidth=Math.max(120,(rect.width-gap*Math.max(0,cols-1))/cols);el.style.setProperty("--mosaic-cell-w",`${cellWidth}px`);el.style.setProperty("--mosaic-tile-h",`${Math.round(cellWidth*0.9)}px`);const cells=Array.from(el.children) as HTMLElement[],shapes=cells.map(declaredShape);cells.forEach((cell,index)=>{const developing=!!cell.querySelector("[data-develop]"),shape=declaredShape(cell),neighbour=developing?nearestShape(shapes,index):undefined;/* A working tile copies the nearest finished tile's shape, so at the shared row height it also has its exact size. */cell.style.setProperty("--tile-aspect",String(shape&&shape>0.1?shape:neighbour??(developing?2.2:16/9)));});};
    const sizes=new ResizeObserver(layout);sizes.observe(el);for(const cell of Array.from(el.children))sizes.observe(cell);
    const medias=Array.from(el.querySelectorAll("video,img"));
    for(const media of medias){media.addEventListener("loadedmetadata",layout);media.addEventListener("load",layout);}
    const feed=new MutationObserver(layout);feed.observe(el,{childList:true});layout();
    const retry=setTimeout(layout,400);
    return()=>{sizes.disconnect();feed.disconnect();clearTimeout(retry);for(const media of medias){media.removeEventListener("loadedmetadata",layout);media.removeEventListener("load",layout);}};
 },[cols,justified]);
 /* Measured masonry (useMasonry): a working tile first takes its nearest finished neighbour's shape and span,
    a landscape clip takes two columns when the column count is even and at least four, so it reads bigger than a
    portrait tile; with 3 or 5 columns a run of two-column clips would leave the last column empty. */
 useMasonry(grid,cols,{enabled:!justified,
  prepare:cells=>{const shapes=cells.map(tileShape);cells.forEach((cell,index)=>{if(!cell.querySelector('[data-develop]'))return;const shape=nearestShape(shapes,index);if(shape)cell.style.setProperty('--mosaic-neighbour',String(shape));else cell.style.removeProperty('--mosaic-neighbour');});},
  span:cells=>{const shapes=cells.map(tileShape);return shapes.map((shape,index)=>{const near=nearestFinished(shapes,index),effective=shape??(near===undefined?null:shapes[near]);return effective&&effective>=1.15&&cols>=4&&cols%2===0?2:1;});}});
 return <section className="ds-mosaic" aria-label={label}>
  {head&&<div className="ds-mosaic__head"><span className="ds-mosaic__title">{head.start}</span>{head.end&&<span className="ds-mosaic__filter">{head.end}</span>}</div>}
  <div ref={grid} className="ds-mosaic__grid" role="list" data-square={square||undefined} data-justified={justified||undefined} style={{['--mosaic-cols' as string]:cols,['--mosaic-row' as string]:`${ROW}px`,['--mosaic-tile-h' as string]:`${tileHeight}px`} as CSSProperties}>
   <MediaSequence>{children}</MediaSequence>
  </div>
 </section>;
}

/** One tile, one column wide; its height is that of the picture or clip inside. */
export function MosaicTile({current,id,shape,children}:{/** No longer changes the size; kept for callers. */accent?:0|1|2;/** Kept for callers; the media sets the height. */aspect?:number;
 /** Width / height of the media when it is already known: the tile keeps that shape while the media loads. */
 shape?:number|null;
 /** Made in the app that is open now: marked quietly. */
 current?:boolean;id?:string;children:ReactNode}){
 return <div id={id} className="ds-mosaic__cell" role="listitem" data-current={current||undefined}>
  <div className="ds-mosaic__inner" data-shaped={shape?true:undefined} style={shape?{['--mosaic-shape' as string]:shape} as CSSProperties:undefined}>{children}</div>
 </div>;
}

