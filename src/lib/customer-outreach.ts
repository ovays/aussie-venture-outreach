import 'server-only'
import { createWorkspaceServiceClient } from '@/lib/supabase/workspace-service'
import { getOnboardingState } from '@/lib/onboarding-server'
import { followUpOrderValid } from '@/lib/onboarding'
import { getWorkspaceSenderIdentity } from '@/lib/sender-identity'
import { listMailboxConnections } from '@/lib/mailbox/connections'

export async function getCustomerOutreach(workspaceId:string,canEdit:boolean){
 const db=createWorkspaceServiceClient(workspaceId);const state=await getOnboardingState(workspaceId);const [{data:categories,error},identity,mailboxes]=await Promise.all([db.from('categories').select('id,name,status,cities,custom_cities').order('name'),getWorkspaceSenderIdentity(db),listMailboxConnections(db)]);if(error)throw new Error(error.message)
 const locations=state.locations.map(({id,city,suburb})=>({id,city,suburb}));const avEnvironmentMailbox=(workspaceId===process.env.HOSTINGER_WORKSPACE_ID||workspaceId===process.env.RESEND_INBOUND_WORKSPACE_ID)&&Boolean(process.env.RESEND_API_KEY||process.env.RESEND_API_KEY_V2);const checks={onboardingComplete:state.status==='completed',categories:(categories??[]).length>0,locations:locations.length>0,mailbox:mailboxes.some(row=>row.status==='connected'&&row.capabilities.canSend)||avEnvironmentMailbox,identity:Boolean(identity.senderName&&identity.brandName),businessIdentity:Boolean(identity.contactEmail.includes('@')),unsubscribe:true,suppression:true,personalisation:state.mode==='template'||state.mode==='ai_personalised',followups:followUpOrderValid(state)}
 return {canEdit,categories:(categories??[]).map(row=>({id:row.id,name:row.name,enabled:row.status==='active',locations:Array.isArray(row.custom_cities)&&row.custom_cities.length?row.custom_cities:locations.map(item=>item.suburb?`${item.suburb}, ${item.city}`:item.city)})),locations,mode:state.mode,automaticFollowups:state.automaticFollowups,schedule:{first:state.first,second:state.second,final:state.final,reconnect:state.reconnect},readiness:{checks,complete:Object.values(checks).every(Boolean),systemActive:false}}
}
