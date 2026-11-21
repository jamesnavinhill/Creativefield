import {useState} from "react";
import {Button,Dialog,LinkButton,Meta,Notice,TextField,Toolbar} from "../ds";
import {request} from "./api";

/** One status per dialog: editing → busy → signed in, or → confirm (email link sent). */
type Phase={kind:"edit";error?:string}|{kind:"busy"}|{kind:"confirm";email:string};
export const COMFY_KEY_LINE="A Comfy key is optional: add it later to render on your own Comfy credits, and it stays in this browser.";

/** Hosted sign-up and sign-in: Google, GitHub or email. The Comfy key is a later, separate step. */
export function AccountDialog({onClose,onSignedIn,onComfyKey}:{onClose:()=>void;onSignedIn:()=>Promise<void>;onComfyKey:()=>void}){
  const [signup,setSignup]=useState(true),[email,setEmail]=useState(""),[password,setPassword]=useState(""),[phase,setPhase]=useState<Phase>({kind:"edit"});
  const busy=phase.kind==="busy";
  async function submit(){
    if(busy||!email.trim()||password.length<8)return;
    setPhase({kind:"busy"});
    try{
      const result=await request<{confirm?:boolean}>("/auth/account","POST",{mode:signup?"signup":"signin",email,password});
      if(result.confirm){setPhase({kind:"confirm",email});return;}
      await onSignedIn();onClose();
    }catch(e){setPhase({kind:"edit",error:(e as Error).message});}
  }
  if(phase.kind==="confirm")return <Dialog open title="Check your email" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
    <Notice tone="info" title="One more step">We sent a link to {phase.email}. Open it in this browser to finish your account.</Notice>
  </Dialog>;
  return <Dialog open title={signup?"Create your account":"Sign in"} onClose={onClose}
    footer={<><Button variant="ghost" onClick={()=>{onClose();onComfyKey();}}>Use a Comfy key instead</Button><Button variant="primary" disabled={busy||!email.trim()||password.length<8} onClick={()=>void submit()}>{busy?"Please wait…":signup?"Create account":"Sign in"}</Button></>}>
    <Toolbar>
      <LinkButton variant="secondary" href="/api/v1/auth/account/oauth/google">Continue with Google</LinkButton>
      <LinkButton variant="secondary" href="/api/v1/auth/account/oauth/github">Continue with GitHub</LinkButton>
    </Toolbar>
    <form onSubmit={event=>{event.preventDefault();void submit();}}>
      <TextField label="Email" type="email" autoComplete="username" autoFocus value={email} onChange={setEmail}/>
      <TextField label="Password" type="password" minLength={8} autoComplete={signup?"new-password":"current-password"} hint={signup?"At least 8 characters":undefined}
        value={password} onChange={setPassword} error={phase.kind==="edit"?phase.error:undefined}/>
    </form>
    <Button variant="ghost" disabled={busy} onClick={()=>{setSignup(!signup);setPhase({kind:"edit"});}}>{signup?"Have an account? Sign in":"New here? Create an account"}</Button>
    <Meta>{COMFY_KEY_LINE}</Meta>
  </Dialog>;
}

/** After Google, GitHub or an email link, Supabase returns here with #access_token=…; it becomes our session. */
export async function finishAccountRedirect(): Promise<void> {
  if(typeof location==="undefined"||!location.hash.includes("access_token="))return;
  const accessToken=new URLSearchParams(location.hash.slice(1)).get("access_token"),state=new URLSearchParams(location.search).get("cf_state");
  history.replaceState(null,"",location.pathname);
  /* The server only accepts it with the state cookie this browser got when it left (no token injection). */
  if(accessToken&&state)await request("/auth/account/token","POST",{accessToken,state});
}
