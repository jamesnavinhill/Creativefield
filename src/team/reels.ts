/** Decorative loops shown behind model cards and section surfaces. Generated promo clips are
    illustrative, while docs/REELS.md describes the separately recorded workflow examples. */

import {isOpenJutsuSingleSwap} from "../capabilities/tasks";

/** Feature cards, by the workflow they run. Restyle and Effects share the VACE family: the reference
    route is the restyle card, the canny presets are the effects looks. */
const REELS = {
  "h3-t2v": "/examples/promo/video-studio.mp4",
  "h3-i2v": "/examples/promo/video-studio.mp4",
  "h3-flf2v": "/examples/promo/video-studio.mp4",
  "h3-effects": "/examples/promo/effects-lab.mp4",
  "h3-effects-hyperflow": "/examples/promo/effects-lab.mp4",
  "h3-object-swap": "/examples/promo/swap-thing.mp4",
  "h3-object-swap-hyperflow": "/examples/promo/swap-thing.mp4",
  "h3-object-swap-hyperflow-area": "/examples/promo/swap-thing.mp4",
  "openjutsu-h3-swap": "/examples/squarehead/jutsu-01.mp4",
  "openjutsu-h3-swap-hyperflow": "/examples/squarehead/jutsu-01.mp4",

  "wan-animate2-distilled": "/reels/mj-07.mp4",
  "wan21-vace-masked-edit": "/reels/feature-swap.mp4",
  "wan21-vace-masked-edit-reference": "/reels/feature-swap.mp4",
  "wan21-vace-two-region-edit": "/reels/feature-swap.mp4",
  "vace-reference-restyle": "/reels/mj-04.mp4",
  "vace-canny-restyle": "/reels/feature-effects.mp4",
  "vace-canny-restyle-14b": "/reels/feature-effects.mp4",
  "vace-depth-restyle": "/reels/feature-effects.mp4",
  /* Create Video models: the ocean take of wan22-ti2v-5b-t2v, and placeholder loops (Midjourney clips) until each model has its own. */
  "wan22-flf2v-14b": "/reels/mj-01.mp4",
  "wan22-i2v-14b": "/reels/mj-02.mp4",
  "camera": "/reels/mj-03.mp4",
  "wan22-ti2v-5b": "/reels/wan22-t2v-5b.mp4",
  "wan22-ti2v-5b-t2v": "/reels/wan22-t2v-5b.mp4",
} as const;

/** The placeholder clips that take turns behind heroes (Midjourney set). */
/* The hero rotation is the Creative Field loops of the All tools tiles (CONVE-1747); the earlier reels are gone from it. */
export const POOL_VIDEOS = ["video", "film", "effect-clips", "swap-person", "ad", "block", "talk", "keyframes", "filmstudio", "model3d"].map((id) => `/examples/tiles/${id}.mp4`);

/** Newest finished video examples appear first in the shared feed and Library. */
export const FEATURED_VIDEO_EXAMPLES = ["/examples/promo/beach-portrait.mp4"];

/** Squarehead's OpenJutsu examples and stills extracted from those actual renders. */
export const SQUAREHEAD_EXAMPLE_VIDEOS = Array.from({length:5},(_,i)=>`/examples/squarehead/jutsu-0${i+1}.mp4`);
export const SQUAREHEAD_EXAMPLE_IMAGES = Array.from({length:5},(_,i)=>`/examples/squarehead/jutsu-0${i+1}.webp`);

/** Actual local OpenJutsu renders, with their corresponding input assets. */
export const OPENJUTSU_SHOWCASE = Array.from({length:4},(_,index)=>{
  const number=index+1;
  return {result:`/examples/showcase/result-${number}.mp4`,original:`/examples/showcase/original-${number}.mp4`,source:`/examples/showcase/source-${number}.mp4`,character:`/examples/showcase/character-${number}.png`,number};
});

/** The early test clips: grey-backdrop studio tests, colour gradients, the first ocean take and one plain promo.
    They stay available, but every feed shows them last and never rotates them to the top. */
export const LOW_PRIORITY_EXAMPLES:readonly string[] = [
  ...["persona-studio"].map(name=>`/examples/promo/${name}.mp4`),
  ...["feature-effects","feature-swap","wan22-flf-14b","wan22-i2v-14b","wan22-i2v-5b","wan22-t2v-5b"].map(name=>`/reels/${name}.mp4`),
];

/** All bundled video examples, in the order feeds show them: the OpenJutsu renders, the best promo clips, the
    Midjourney loops, then the early test clips. Available in the Library and media picker. */
export const LIBRARY_EXAMPLE_VIDEOS = [...FEATURED_VIDEO_EXAMPLES,...SQUAREHEAD_EXAMPLE_VIDEOS,...OPENJUTSU_SHOWCASE.map(item=>item.result),
  ...["reshoot","effects-lab","copy-moves","film-studio","block-shot","swap-thing","new-look","video-studio","ad-studio"].map(name=>`/examples/promo/${name}.mp4`),
  ...POOL_VIDEOS,...["upscale","edit","picture","character","angles","relight"].map(id=>`/examples/tiles/menu-${id}.mp4`),"/examples/tiles/block-grey.mp4","/examples/tiles/replace-source.mp4",...Array.from({ length: 8 }, (_, i) => `/reels/mj-0${i}.mp4`),...LOW_PRIORITY_EXAMPLES];

/** These clips illustrate each area; they are not claims that the named workflow made the clip. */
export function promoReelForCapability(ids?:string|string[]){
  const map:Record<string,string>={"h3-t2v":"video-studio","h3-i2v":"video-studio","h3-flf2v":"video-studio","h3-effects":"effects-lab","h3-effects-hyperflow":"effects-lab","h3-object-swap":"swap-thing","h3-object-swap-hyperflow":"swap-thing","h3-object-swap-hyperflow-area":"swap-thing","openjutsu-h3-swap":"reshoot"};
  if([ids??""].flat().some(isOpenJutsuSingleSwap))return SQUAREHEAD_EXAMPLE_VIDEOS[0];
  const name=[ids??""].flat().map(id=>map[id]).find(Boolean);
  return name?`/examples/promo/${name}.mp4`:undefined;
}

/** A thematic still for an image workspace, not an example of a specific edit. */
export function promoStillForImage(id:string,ad=false,remix=false){
  const name=ad?"ad-studio":remix?"remix-studio":/angles/.test(id)?"angles":/edit|inpaint/.test(id)?"photofield":/t2i/.test(id)?"identity-studio":undefined;
  return name?`/examples/promo/${name}.webp`:undefined;
}

/** The one loop behind a whole section's surfaces. */
const SECTION_REELS: Record<string, string> = {
  video: REELS["wan22-ti2v-5b-t2v"],
  image: "/reels/mj-05.mp4",
  characters: "/reels/mj-06.mp4",
  influencer: "/reels/mj-00.mp4",
};

/** A card without a reel of its own shows none: it never borrows a gradient. */
export const NO_REEL = "";

export function reelForManifest(id?: string): string | undefined {
  return id && id in REELS ? REELS[id as keyof typeof REELS] : undefined;
}

export function reelForSection(section: string): string | undefined {
  return SECTION_REELS[section];
}

/** The Creative Field loop behind a workspace's model card, chosen by what the workflow does (its id and its function
    name), so every workspace opens on the same characters as All tools. Undefined when nothing fits. */
const CARD_LOOPS:[RegExp,string][]=[
  [/openjutsu|replace|scail|swap-person|character/i,"swap-person"],
  [/lip|talk|infinitetalk|voice/i,"talk"],
  [/effect/i,"effect-clips"],
  [/keyframe|flf|first.and.last/i,"keyframes"],
  [/previs|block|make.it.real/i,"block"],
  [/storyboard|film|shot/i,"film"],
  [/upscale|enhance|sharpen|esrgan|seedvr|interpolat|finish/i,"menu-upscale"],
  [/trim|edit.video|cut/i,"menu-edit"],
  [/relight/i,"menu-relight"],
  [/angle|turn/i,"menu-angles"],
  [/3d|mesh|hunyuan3d|trellis/i,"model3d"],
  [/ad.studio|marketing|product/i,"ad"],
  [/t2i|text.to.image|picture|image/i,"menu-picture"],
  [/t2v|i2v|text.to.video|image.to.video|video|motion|animate/i,"video"],
];
export function cardLoop(...hints:(string|undefined)[]):string|undefined{
  const key=hints.filter(Boolean).join(" ");
  const hit=CARD_LOOPS.find(([re])=>re.test(key));
  return hit?`/examples/tiles/${hit[1]}.mp4`:undefined;
}

/** Creative Field examples made in this app, each with the one run behind it, so Recreate opens the tool filled in:
    locally the same workflow, files, prompt and seed; online the matching cloud tool with the same files and prompt.
    A tile that shows several runs at once (a wipe, cuts, pins) names the one run it is about. */
type File={src:string;name:string};
export type ExampleRecipe={title:string;mode:string;model:string;
  /** The local workflow, or "trim" for the clip editor (no model; the same locally and online). */
  capabilityId:string;inputs:Record<string,File>;controls?:Record<string,string|number|boolean>;prompt?:string;
  cloud?:{hash:string;inputs:Record<string,File>;prompt:string};info:{src:string;label:string;video?:boolean}[];facts?:{label:string;value:string}[]};
const T="/examples/tiles/";
const file=(name:string):File=>({src:`${T}${name}`,name});
/** One HyperFlow H3 Flash image-to-video loop (1024×576, 3 s); online it is Seedance Create Video. */
const i2v=(title:string,still:string,seed:number,prompt:string):ExampleRecipe=>({title,mode:"Image to video",model:"HyperFlow H3 Flash",capabilityId:"hyperflow-h3-flash-i2v",
  inputs:{start_image:file(still)},controls:{prompt,width:1024,height:576,length:3,quality:"normal",seed},prompt,
  cloud:{hash:"#video/create",inputs:{start_image:file(still)},prompt},info:[{src:`${T}${still}`,label:"Start picture"}],facts:[{label:"Size",value:"1024 × 576 · 3 s"},{label:"Seed",value:String(seed)}]});
const KEYFRAMES="He completes the leap across the gap and lands in a crouch on the far rooftop, smooth continuous motion, city lights below.";
const BLOCK="Turn the grey untextured blocking shapes into a real place: a sunlit sandstone canyon with real rock, sand, sky and warm light, every block becoming the real object in the same position and size. Keep the character, the camera move and the composition.";
const REPLACE="Replace the cube-headed character in the video with the young man from the reference picture: his face, yellow CF beanie, black CF hoodie, cargo trousers and sneakers. Keep the samurai pose, the katana, the camera move, the bamboo forest and the light.";
const UPSCALE="Rebuild this picture as a photorealistic, high-detail image: preserve the exact composition, framing, lighting, colours and identity, but replace blur, mush and compression with clean natural micro-detail, sharp realistic textures and crisp edges. Do not add, remove or move objects.";
export const EXAMPLE_RECIPES:Record<string,ExampleRecipe>={
  [`${T}video.mp4`]:i2v("Hoverbike in the neon city","video.webp",1116,"The hoverbike speeds forward through the neon city, the camera tracks alongside, rain streaks and light trails rush past. His head and yellow CF beanie stay steady and in focus."),
  [`${T}effect-clips.mp4`]:i2v("Ember storm on a dune","effect-clips.webp",1116,"The storm of glowing embers spirals faster around him, sparks rushing upward, his hoodie flutters, the camera pushes in slowly."),
  [`${T}ad.mp4`]:i2v("Sneaker splash","ad.webp",1116,"Water droplets splash slowly around the sneaker on the pedestal, the camera orbits slowly, rim light glints."),
  [`${T}talk.mp4`]:i2v("Radio booth","talk.webp",1116,"He speaks into the microphone with natural lip movement and small head gestures, warm dust floats in the light."),
  [`${T}model3d.mp4`]:i2v("Vinyl figure on a turntable","model3d.webp",1116,"The vinyl figure turns slowly on the white turntable, a smooth full rotation, soft studio light."),
  [`${T}filmstudio.mp4`]:i2v("On the grey film set","filmstudio.webp",1116,"He snaps the clapperboard shut, the camera on the dolly rolls slowly forward along the track, work lights flicker."),
  [`${T}menu-picture.mp4`]:i2v("Orbital greenhouse","picture.webp",1116,"The character floats slowly in the orbital greenhouse, ferns sway, sunbeams drift, the camera drifts gently."),
  [`${T}menu-character.mp4`]:i2v("Character select","character.webp",1116,"The two characters on the pedestals turn their heads toward the camera, spotlights pulse, light bars glow."),
  [`${T}menu-angles.mp4`]:i2v("Turnaround orbit","angles.webp",1116,"The camera orbits slowly around the character, smooth continuous arc, soft studio light."),
  [`${T}menu-relight.mp4`]:i2v("Street from day to night","new-look-before.webp",1117,"Time-lapse: the sunny street turns from golden afternoon into deep blue night, the sun sets behind the palms, street lamps and shop neon switch on and glow, the character stays still on the skateboard, the camera holds still."),
  [`${T}keyframes.mp4`]:{title:"Rooftop leap between two keyframes",mode:"Keyframes",model:"HyperFlow H3 Flash",capabilityId:"hyperflow-h3-flash-i2v",
    inputs:{start_image:file("keyframes.webp"),end_image:file("keyframes-end.webp")},controls:{prompt:KEYFRAMES,width:1024,height:576,length:3,quality:"normal",seed:1116},prompt:KEYFRAMES,
    cloud:{hash:"#video/keyframes",inputs:{start_image:file("keyframes.webp"),end_image:file("keyframes-end.webp")},prompt:KEYFRAMES},
    info:[{src:`${T}keyframes.webp`,label:"Keyframe 1"},{src:`${T}keyframes-end.webp`,label:"Keyframe 2"}],facts:[{label:"Size",value:"1024 × 576 · 3 s"}]},
  [`${T}block.mp4`]:{title:"Grey blockout to a real canyon",mode:"Make it real",model:"HyperFlow H3 Flash",capabilityId:"previs-to-video-hyperflow",
    inputs:{source_video:file("block-grey.mp4")},controls:{prompt:BLOCK},prompt:BLOCK,
    cloud:{hash:"#video/transform/restyle",inputs:{source_video:file("block-grey.mp4")},prompt:BLOCK},
    info:[{src:`${T}block-grey.mp4`,label:"Grey blockout",video:true}]},
  [`${T}swap-person.mp4`]:{title:"Squarehead recast as the Boy",mode:"Replace character",model:"HyperFlow H3 Flash · OpenJutsu",capabilityId:"openjutsu-h3-swap-hyperflow",
    inputs:{source_video:file("replace-source.mp4"),character_image:file("boy.webp")},controls:{prompt:REPLACE,seconds:3},prompt:REPLACE,
    cloud:{hash:"#video/transform/person",inputs:{source_video:file("replace-source.mp4"),reference_image:file("boy.webp")},prompt:REPLACE},
    info:[{src:`${T}replace-source.mp4`,label:"Source clip",video:true},{src:`${T}boy.webp`,label:"New character"}]},
  [`${T}menu-upscale.mp4`]:{title:"Pixelated pier made sharp",mode:"Upscale",model:"Fibo 2.0",capabilityId:"fibo2-edit",
    inputs:{source_image:file("sharpen-before.webp")},controls:{prompt:UPSCALE,megapixels:4,steps:4,sampler:"euler_ancestral",improve_prompt:false,seed:79},prompt:UPSCALE,
    cloud:{hash:"#image/upscale",inputs:{source_image:file("sharpen-before.webp")},prompt:""},
    info:[{src:`${T}sharpen-before.webp`,label:"Low-resolution picture"}]},
  [`${T}menu-edit.mp4`]:{title:"Short film in the clip editor",mode:"Edit video",model:"Trim and crop",capabilityId:"trim",
    inputs:{source_video:file("film.mp4")},info:[{src:`${T}film.mp4`,label:"Clip",video:true}]},
};
export const RECIPE_VIDEOS=Object.keys(EXAMPLE_RECIPES);
