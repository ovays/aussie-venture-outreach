import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { ONBOARDING_SETTING_KEYS as K } from '@/lib/onboarding'

export interface WorkspaceSenderIdentity { senderName:string;brandName:string;contactEmail:string;website:string;businessAddress:string }

export async function getWorkspaceSenderIdentity(db: SupabaseClient<Database>): Promise<WorkspaceSenderIdentity> {
  const keys=[K.senderName,K.brandName,K.contactEmail,K.website,K.businessAddress]
  const {data,error}=await db.from('workspace_settings').select('key,value').in('key',keys)
  if(error)throw new Error('Unable to verify sender identity')
  const values=new Map((data??[]).map(row=>[row.key,row.value.trim()]))
  return {senderName:values.get(K.senderName)??'',brandName:values.get(K.brandName)??'',contactEmail:values.get(K.contactEmail)??'',website:values.get(K.website)??'',businessAddress:values.get(K.businessAddress)??''}
}
export function assertCompleteSenderIdentity(identity:WorkspaceSenderIdentity):void{
  if(!identity.senderName||!identity.brandName||!identity.contactEmail.includes('@'))throw new Error('Workspace sender identity is incomplete')
}
export function messageIdForMailbox(emailIntentId:string,mailboxAddress:string):string{
  const domain=mailboxAddress.split('@')[1]?.toLowerCase()
  if(!domain||!/^[a-z0-9.-]+$/.test(domain))throw new Error('Connected mailbox has an invalid sender domain')
  return `<${emailIntentId}@${domain}>`
}
export function addComplianceFooter(request:{html:string;text:string},identity:WorkspaceSenderIdentity,unsubscribeUrl:string){
  const identification=[identity.brandName,identity.businessAddress,identity.contactEmail].filter(Boolean).join(' · ')
  const safe=identification.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
  return {html:`${request.html}<p style="margin-top:24px;font-size:12px;color:#64748b">${safe}<br><a href="${unsubscribeUrl}">Unsubscribe</a></p>`,text:`${request.text}\n\n${identification}\nUnsubscribe: ${unsubscribeUrl}`}
}
