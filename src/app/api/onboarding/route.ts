import { NextRequest, NextResponse } from 'next/server'
import { isAuthErrorResponse, requireApiUser } from '@/lib/auth'
import { requireWorkspaceContext } from '@/lib/workspace-context'
import { createServiceClient } from '@/lib/supabase/server'
import { ONBOARDING_SETTING_KEYS as K, onboardingRequestSchema } from '@/lib/onboarding'
import { getOnboardingState, upsertOnboardingSettings } from '@/lib/onboarding-server'
import { checkRateLimit } from '@/lib/rateLimit'

const invalid=(issues:Array<{path:PropertyKey[];message:string}>)=>NextResponse.json({error:'Check the highlighted fields',fieldErrors:Object.fromEntries(issues.map(i=>[String(i.path.at(-1)??'form'),i.message]))},{status:400})
export async function PATCH(request:NextRequest){
 const auth=await requireApiUser();if(isAuthErrorResponse(auth))return auth;const {allowed}=checkRateLimit(`onboarding:${auth.user.id}`,60);if(!allowed)return NextResponse.json({error:'Rate limit exceeded'},{status:429})
 const ws=await requireWorkspaceContext(auth);if(!(ws.isPlatformAdmin||ws.role==='owner'||ws.role==='admin'))return NextResponse.json({error:'Workspace admin access is required'},{status:403})
 let body:unknown;try{body=await request.json()}catch{return NextResponse.json({error:'Invalid JSON body'},{status:400})}const parsed=onboardingRequestSchema.safeParse(body);if(!parsed.success)return invalid(parsed.error.issues)
 const input=parsed.data,current=await getOnboardingState(ws.workspaceId);if(current.status==='completed')return NextResponse.json({data:current});const db=createServiceClient()
 if(input.action==='navigate'){if(input.step>current.currentStep)return NextResponse.json({error:'Complete the current step before continuing'},{status:409});await progress(ws.workspaceId,input.step)}
 if(input.action==='advance'){
  if(input.step!==current.currentStep)return NextResponse.json({error:'Refresh and resume your current onboarding step'},{status:409})
  if(input.step===1){const d=input.data;const {error}=await db.from('workspaces').update({name:d.workspaceName}).eq('id',ws.workspaceId);if(error)return NextResponse.json({error:error.message},{status:500});await upsertOnboardingSettings(ws.workspaceId,{[K.website]:d.website,[K.industry]:d.industry,[K.country]:d.country,[K.primaryCity]:d.primaryCity,[K.senderName]:d.senderName,[K.contactEmail]:d.contactEmail,[K.businessAddress]:d.businessAddress??''})}
  if(input.step===2)await upsertOnboardingSettings(ws.workspaceId,{[K.mailboxSkipped]:String(input.data.skip)})
  if(input.step===3){const names=[...new Set(input.data.names.map(n=>n.trim()))];const {data:existing,error:readError}=await db.from('categories').select('name').eq('workspace_id',ws.workspaceId);if(readError)return NextResponse.json({error:readError.message},{status:500});const known=new Set((existing??[]).map(r=>r.name.trim().toLowerCase()));const missing=names.filter(n=>!known.has(n.toLowerCase()));if(missing.length){const {error}=await db.from('categories').insert(missing.map(name=>({workspace_id:ws.workspaceId,name,status:'paused'})));if(error)return NextResponse.json({error:error.message},{status:500})}}
  if(input.step===4){await db.from('city_suburbs').delete().eq('workspace_id',ws.workspaceId);const {error}=await db.from('city_suburbs').insert(input.data.locations.map(v=>({workspace_id:ws.workspaceId,city:v.city,suburb:v.suburb||v.city,active:true})));if(error)return NextResponse.json({error:error.message},{status:500});await upsertOnboardingSettings(ws.workspaceId,{[K.activeCities]:[...new Set(input.data.locations.map(v=>v.city))].join(','),[K.primaryCity]:input.data.locations[0].city})}
  if(input.step===5)await upsertOnboardingSettings(ws.workspaceId,{[K.mode]:input.data.mode})
  if(input.step===6){const d=input.data;await upsertOnboardingSettings(ws.workspaceId,{[K.automaticFollowups]:String(d.automaticFollowups),[K.first]:String(d.first),[K.second]:String(d.second),[K.final]:String(d.final),[K.reconnect]:String(d.reconnect),[K.reactivationEnabled]:'false'})}
  if(input.step===7&&input.data.invite){const invite=input.data.invite;const {data:profile}=await db.from('profiles').select('id').eq('email',invite.email.toLowerCase()).maybeSingle();if(profile){const {error}=await db.from('workspace_members').upsert({workspace_id:ws.workspaceId,user_id:profile.id,role:invite.role,status:'active'});if(error)return NextResponse.json({error:error.message},{status:500})}else{const {error}=await db.from('workspace_invitations').upsert({workspace_id:ws.workspaceId,email:invite.email.toLowerCase(),role:invite.role,status:'pending',invited_by:auth.user.id},{onConflict:'workspace_id,email,status'});if(error)return NextResponse.json({error:error.message},{status:500})}}
  await progress(ws.workspaceId,(input.step+1) as number)
 }
 if(input.action==='complete'){if(current.currentStep!==9)return NextResponse.json({error:'Complete the review before finishing'},{status:409});await upsertOnboardingSettings(ws.workspaceId,{[K.status]:'completed',[K.currentStep]:'9',[K.completedAt]:new Date().toISOString(),[K.systemActive]:'false',[K.reactivationEnabled]:'false'})}
 return NextResponse.json({data:await getOnboardingState(ws.workspaceId)})
}
async function progress(workspaceId:string,step:number){await upsertOnboardingSettings(workspaceId,{[K.status]:'in_progress',[K.currentStep]:String(step)})}
