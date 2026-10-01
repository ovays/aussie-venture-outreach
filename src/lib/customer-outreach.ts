import 'server-only'
import { createWorkspaceServiceClient } from '@/lib/supabase/workspace-service'
import { getOnboardingState } from '@/lib/onboarding-server'
import { followUpOrderValid } from '@/lib/onboarding'

export async function getCustomerOutreach(workspaceId:string,canEdit:boolean){
 const db=createWorkspaceServiceClient(workspaceId);const state=await getOnboardingState(workspaceId);const {data:categories,error}=await db.from('categories').select('id,name,status,cities,custom_cities').order('name');if(error)throw new Error(error.message)
 const locations=state.locations.map(({id,city,suburb})=>({id,city,suburb}));const checks={onboardingComplete:state.status==='completed',categories:(categories??[]).length>0,locations:locations.length>0,mailbox:state.mailboxConnected,personalisation:state.mode==='template'||state.mode==='ai_personalised',followups:followUpOrderValid(state)}
 return {canEdit,categories:(categories??[]).map(row=>({id:row.id,name:row.name,enabled:row.status==='active',locations:Array.isArray(row.custom_cities)&&row.custom_cities.length?row.custom_cities:locations.map(item=>item.suburb?`${item.suburb}, ${item.city}`:item.city)})),locations,mode:state.mode,automaticFollowups:state.automaticFollowups,schedule:{first:state.first,second:state.second,final:state.final,reconnect:state.reconnect},readiness:{checks,complete:Object.values(checks).every(Boolean),systemActive:false}}
}
