/** Providers a workspace can bring its own key for (BYOK,). Only providers with a working
 *  adapter are listed (DS rule 26); add one here together with its server adapter. */
export const OWN_KEY_PROVIDERS=[
  {id:"comfy-router",name:"Comfy",keyUrl:"https://platform.comfy.org/profile/api-keys",hint:"Runs every cloud model on your Comfy credits."},
  {id:"bfl",name:"Black Forest Labs",keyUrl:"https://dashboard.bfl.ai/",hint:"Runs FLUX 2 Pro pictures on your own BFL credits."},
] as const;
export const OWN_KEY_NAMES:Record<string,string>=Object.fromEntries(OWN_KEY_PROVIDERS.map(p=>[p.id,p.name]));
