'use client'
import { useState } from 'react'
import { useParams } from 'next/navigation'

export default function UnsubscribePage(){
 const params=useParams<{token:string}>(),[status,setStatus]=useState<'ready'|'working'|'done'|'error'>('ready'),[message,setMessage]=useState('')
 async function unsubscribe(){setStatus('working');const response=await fetch('/api/unsubscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:params.token})});const body=await response.json();setMessage(body.message??body.error??'Unable to process request');setStatus(response.ok?'done':'error')}
 return <main className="mx-auto flex min-h-screen max-w-lg items-center px-5"><section className="w-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-8 text-center"><h1 className="text-xl font-semibold">Unsubscribe</h1>{status==='done'?<p className="mt-4 text-sm text-[var(--text-secondary)]">{message}</p>:<><p className="mt-3 text-sm text-[var(--text-secondary)]">Stop future outreach to the email address linked to this message.</p><button onClick={()=>void unsubscribe()} disabled={status==='working'} className="mt-6 rounded-lg bg-[var(--primary)] px-5 py-2.5 text-sm font-medium text-white disabled:opacity-60">{status==='working'?'Unsubscribing…':'Unsubscribe'}</button>{status==='error'&&<p role="alert" className="mt-4 text-sm text-[var(--error)]">{message}</p>}</>}</section></main>
}
