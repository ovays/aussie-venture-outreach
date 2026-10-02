import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/server'
import { recordRecipientUnsubscribe } from '@/lib/suppression'
import { checkRateLimit } from '@/lib/rateLimit'

const schema=z.object({token:z.string().max(100)}).strict()
export async function POST(request:NextRequest):Promise<NextResponse>{
  const ip=request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()??'unknown'
  if(!checkRateLimit(`unsubscribe:${ip}`,20).allowed)return NextResponse.json({error:'Please try again later.'},{status:429})
  const parsed=schema.safeParse(await request.json().catch(()=>null))
  if(!parsed.success)return NextResponse.json({error:'This unsubscribe link is invalid.'},{status:400})
  try{
    const result=await recordRecipientUnsubscribe(createServiceClient() as any,parsed.data.token)
    if(result==='invalid')return NextResponse.json({error:'This unsubscribe link is invalid or has expired.'},{status:400})
    return NextResponse.json({success:true,message:'You have been unsubscribed. No further outreach will be sent to this address.'})
  }catch{return NextResponse.json({error:'We could not process this request. Please try again.'},{status:500})}
}
