import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { ONBOARDING_SETTING_KEYS as K, parseOnboardingStatus, parseOnboardingStep, type OnboardingState } from '@/lib/onboarding'

export async function getOnboardingState(workspaceId:string):Promise<OnboardingState>{
 const db=createServiceClient(); const [{data:w,error:we},{data:s,error:se},{data:c},{data:l},{data:m},{data:mb},{data:i}]=await Promise.all([
  db.from('workspaces').select('name').eq('id',workspaceId).single(), db.from('workspace_settings').select('key,value').eq('workspace_id',workspaceId),
  db.from('categories').select('id,name').eq('workspace_id',workspaceId).order('name'), db.from('city_suburbs').select('id,city,suburb').eq('workspace_id',workspaceId).order('city'),
  db.from('workspace_members').select('user_id,role,status,profiles(full_name,email)').eq('workspace_id',workspaceId), db.from('mailbox_connections').select('id').eq('workspace_id',workspaceId).eq('status','connected').limit(1),
  db.from('workspace_invitations').select('id,email,role,status').eq('workspace_id',workspaceId).eq('status','pending')])
 if(we||se)throw new Error((we??se)!.message); const x=new Map((s??[]).map(r=>[r.key,r.value])); const num=(k:string,d:number)=>Number(x.get(k)??d)
 const members=(m??[]).map((r:any)=>({id:r.user_id,name:r.profiles?.full_name??r.profiles?.email??'Team member',email:r.profiles?.email??'',role:r.role,status:r.status}))
 const invites=(i??[]).map((r:any)=>({id:r.id,name:'Pending invitation',email:r.email,role:r.role,status:r.status,pending:true}))
 return {status:parseOnboardingStatus(x.get(K.status)),currentStep:parseOnboardingStep(x.get(K.currentStep)),completedAt:x.get(K.completedAt)??null,workspaceName:w.name,website:x.get(K.website)??'',industry:x.get(K.industry)??'',country:x.get(K.country)??'Australia',primaryCity:x.get(K.primaryCity)??'',senderName:x.get(K.senderName)??'',contactEmail:x.get(K.contactEmail)??'',timezone:x.get(K.timezone)??'Australia/Sydney',brandName:x.get(K.brandName)??w.name,companyDescription:x.get(K.companyDescription)??'',primaryGoal:x.get(K.primaryGoal)??'',mailboxSkipped:x.get(K.mailboxSkipped)==='true',mailboxConnected:(mb??[]).length>0,categories:c??[],locations:l??[],mode:x.get(K.mode)==='ai_personalised'?'ai_personalised':'template',automaticFollowups:x.get(K.automaticFollowups)==='true',first:num(K.first,7),second:num(K.second,14),final:num(K.final,21),reconnect:num(K.reconnect,90),team:[...members,...invites]}
}
export async function upsertOnboardingSettings(workspaceId:string,values:Record<string,string>){const db=createServiceClient();const {error}=await db.from('workspace_settings').upsert(Object.entries(values).map(([key,value])=>({workspace_id:workspaceId,key,value,description:'ReachAgent customer onboarding',updated_at:new Date().toISOString()})),{onConflict:'workspace_id,key'});if(error)throw new Error(error.message)}
