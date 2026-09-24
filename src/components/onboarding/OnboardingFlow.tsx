'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ArrowRight, Building2, Check, Globe2, Rocket, Send, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import {
  COUNTRY_OPTIONS,
  INDUSTRY_OPTIONS,
  OUTREACH_GOAL_OPTIONS,
  type OnboardingState,
  type OnboardingStep,
} from '@/lib/onboarding'

interface Props {
  initialState: OnboardingState
  timezones: Array<{ value: string; label: string }>
  userEmail: string
  userName: string | null
  canManage: boolean
}

type Errors = Record<string, string>
const steps = ['Welcome', 'Workspace', 'Profile', 'Preferences', 'Ready']

export function OnboardingFlow({ initialState, timezones, userEmail, userName, canManage }: Props) {
  const router = useRouter()
  const [state, setState] = useState(initialState)
  const [step, setStep] = useState<OnboardingStep>(initialState.currentStep)
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)

  async function save(payload: Record<string, unknown>) {
    setBusy(true)
    setErrors({})
    try {
      const response = await fetch('/api/onboarding', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json()
      if (!response.ok) {
        setErrors(body.fieldErrors ?? { form: body.error ?? 'Unable to save your progress' })
        return null
      }
      setState(body.data)
      setStep(body.data.currentStep)
      return body.data as OnboardingState
    } catch {
      setErrors({ form: 'Unable to save right now. Check your connection and try again.' })
      return null
    } finally {
      setBusy(false)
    }
  }

  async function continueFromCurrent() {
    if (step === 1) await save({ action: 'advance', step: 1 })
    if (step === 2) await save({
      action: 'advance', step: 2,
      data: {
        workspaceName: state.workspaceName,
        website: state.website,
        industry: state.industry,
        country: state.country,
        timezone: state.timezone,
      },
    })
    if (step === 3) await save({
      action: 'advance', step: 3,
      data: {
        senderName: state.senderName,
        brandName: state.brandName,
        companyDescription: state.companyDescription,
        primaryGoal: state.primaryGoal,
      },
    })
    if (step === 4) await save({ action: 'advance', step: 4, data: { primaryMarket: state.primaryMarket } })
    if (step === 5) {
      const result = await save({ action: 'complete', step: 5 })
      if (result?.status === 'completed') {
        router.push('/dashboard')
        router.refresh()
      }
    }
  }

  async function goBack() {
    if (step <= 1) return
    await save({ action: 'navigate', step: step - 1 })
  }

  function errorFor(field: string) {
    return errors[field] ? <p id={`${field}-error`} role="alert" className="mt-1.5 text-xs text-[var(--error)]">{errors[field]}</p> : null
  }

  const fieldProps = (field: string) => ({
    'aria-invalid': Boolean(errors[field]),
    'aria-describedby': errors[field] ? `${field}-error` : undefined,
  })

  return (
    <main className="min-h-dvh bg-[var(--background)] px-4 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-6 flex items-center justify-between gap-4 sm:mb-8">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--primary)] font-black text-white shadow-sm">R</span>
            <div><p className="text-sm font-semibold text-[var(--text-primary)]">ReachAgent</p><p className="text-xs text-[var(--text-muted)]">Workspace setup</p></div>
          </div>
          <div className="min-w-0 text-right"><p className="truncate text-sm font-medium text-[var(--text-primary)]">{userName ?? userEmail}</p><p className="truncate text-xs text-[var(--text-muted)]">{state.workspaceName}</p></div>
        </header>

        <nav aria-label="Onboarding progress" className="mb-5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] px-3 py-3 sm:px-5">
          <div className="mb-2 flex items-center justify-between"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--primary)]">Step {step} of 5</p><p className="text-xs text-[var(--text-muted)]">{steps[step - 1]}</p></div>
          <ol className="grid grid-cols-5 gap-2">
            {steps.map((label, index) => {
              const number = index + 1
              const active = number === step
              const done = number < step
              return <li key={label} aria-current={active ? 'step' : undefined} aria-label={`${label}${done ? ', complete' : active ? ', current step' : ''}`} className={`h-1.5 rounded-full ${done || active ? 'bg-[var(--primary)]' : 'bg-[var(--border)]'}`} />
            })}
          </ol>
        </nav>

        <section className="surface overflow-hidden">
          <form onSubmit={(event) => { event.preventDefault(); void continueFromCurrent() }}>
            <div className="min-h-[28rem] p-5 sm:p-8">
              {step === 1 && <Welcome workspaceName={state.workspaceName} />}
              {step === 2 && <WorkspaceStep state={state} setState={setState} errors={errors} errorFor={errorFor} fieldProps={fieldProps} timezones={timezones} />}
              {step === 3 && <ProfileStep state={state} setState={setState} errors={errors} errorFor={errorFor} fieldProps={fieldProps} />}
              {step === 4 && <PreferencesStep state={state} setState={setState} errorFor={errorFor} fieldProps={fieldProps} />}
              {step === 5 && <Ready state={state} />}
              {errors.form && <p role="alert" className="mt-5 rounded-lg border border-[var(--error-border)] bg-[var(--error-muted)] px-3 py-2.5 text-sm text-[var(--error)]">{errors.form}</p>}
              {!canManage && <p role="alert" className="mt-5 rounded-lg border border-[var(--warning-border)] bg-[var(--warning-muted)] px-3 py-2.5 text-sm text-[var(--warning)]">A workspace owner or admin must complete this setup.</p>}
            </div>
            <footer className="flex flex-col-reverse gap-3 border-t border-[var(--border-subtle)] bg-[var(--surface-hover)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
              <Button type="button" variant="ghost" onClick={() => void goBack()} disabled={busy || step === 1} className="w-full sm:w-auto"><ArrowLeft size={16} />Back</Button>
              <Button type="submit" disabled={busy || !canManage} className="w-full sm:w-auto">{busy ? 'Saving…' : step === 1 ? 'Get started' : step === 5 ? 'Go to ReachAgent' : 'Continue'}{!busy && <ArrowRight size={16} />}</Button>
            </footer>
          </form>
        </section>
        <p className="mt-4 text-center text-xs text-[var(--text-muted)]">Your progress is saved securely to this workspace.</p>
      </div>
    </main>
  )
}

function StepHeading({ icon: Icon, eyebrow, title, description }: { icon: typeof Sparkles; eyebrow: string; title: string; description: string }) {
  return <div className="mb-7"><span className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--primary-muted)] text-[var(--primary)]"><Icon size={21} /></span><p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--primary)]">{eyebrow}</p><h1 className="mt-1 text-2xl font-semibold tracking-[-0.03em] text-[var(--text-primary)] sm:text-3xl">{title}</h1><p className="mt-2 max-w-xl text-sm leading-6 text-[var(--text-muted)]">{description}</p></div>
}

function Welcome({ workspaceName }: { workspaceName: string }) {
  return <div className="flex min-h-[23rem] flex-col justify-center"><StepHeading icon={Sparkles} eyebrow="Welcome" title="Let’s set up your outreach workspace" description={`We’ll tailor ${workspaceName} with the essentials ReachAgent needs. This takes about two minutes, and you can update these details later.`} /><div className="grid gap-3 sm:grid-cols-3">{[['Business details', Building2], ['Outreach identity', Send], ['Starting market', Globe2]].map(([label, Icon]) => <div key={label as string} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-hover)] p-4"><Icon size={17} className="mb-2 text-[var(--primary)]" /><p className="text-sm font-medium text-[var(--text-primary)]">{label as string}</p></div>)}</div></div>
}

type StepProps = { state: OnboardingState; setState: React.Dispatch<React.SetStateAction<OnboardingState>>; errors?: Errors; errorFor: (field: string) => React.ReactNode; fieldProps: (field: string) => Record<string, unknown> }

function WorkspaceStep({ state, setState, errorFor, fieldProps, timezones }: StepProps & { timezones: Array<{ value: string; label: string }> }) {
  return <><StepHeading icon={Building2} eyebrow="Workspace / Business" title="Tell us about your business" description="These details identify your workspace and help keep future outreach relevant." /><div className="grid gap-5 sm:grid-cols-2"><div className="sm:col-span-2"><Input label="Workspace / business name" value={state.workspaceName} onChange={(e) => setState({ ...state, workspaceName: e.target.value })} required maxLength={120} autoComplete="organization" {...fieldProps('workspaceName')} />{errorFor('workspaceName')}</div><div className="sm:col-span-2"><Input label="Website URL (optional)" type="url" placeholder="https://example.com" value={state.website} onChange={(e) => setState({ ...state, website: e.target.value })} maxLength={300} autoComplete="url" {...fieldProps('website')} />{errorFor('website')}</div><div><Select label="Industry" placeholder="Select an industry" options={[...INDUSTRY_OPTIONS]} value={state.industry} onChange={(e) => setState({ ...state, industry: e.target.value })} required {...fieldProps('industry')} />{errorFor('industry')}</div><div><Select label="Country" options={[...COUNTRY_OPTIONS]} value={state.country} onChange={(e) => setState({ ...state, country: e.target.value })} required {...fieldProps('country')} />{errorFor('country')}</div><div className="sm:col-span-2"><Select label="Timezone" options={timezones} value={state.timezone} onChange={(e) => setState({ ...state, timezone: e.target.value })} required {...fieldProps('timezone')} />{errorFor('timezone')}</div></div></>
}

function ProfileStep({ state, setState, errorFor, fieldProps }: StepProps) {
  return <><StepHeading icon={Send} eyebrow="Outreach profile" title="Shape your outreach identity" description="Set the human and brand context that will be used when outreach is configured later." /><div className="grid gap-5 sm:grid-cols-2"><div><Input label="Sender / display name" value={state.senderName} onChange={(e) => setState({ ...state, senderName: e.target.value })} required maxLength={120} autoComplete="name" {...fieldProps('senderName')} />{errorFor('senderName')}</div><div><Input label="Brand name used in outreach" value={state.brandName} onChange={(e) => setState({ ...state, brandName: e.target.value })} required maxLength={120} {...fieldProps('brandName')} />{errorFor('brandName')}</div><div className="sm:col-span-2"><label htmlFor="companyDescription" className="mb-1.5 block text-sm font-medium text-[var(--text-secondary)]">Short company description <span className="font-normal text-[var(--text-muted)]">(optional)</span></label><textarea id="companyDescription" className="control-field min-h-28 w-full resize-y px-3 py-2 text-sm" value={state.companyDescription} onChange={(e) => setState({ ...state, companyDescription: e.target.value })} maxLength={500} {...fieldProps('companyDescription')} /><div className="mt-1 flex justify-between gap-3">{errorFor('companyDescription')}<span className="ml-auto text-xs text-[var(--text-muted)]">{state.companyDescription.length}/500</span></div></div><div className="sm:col-span-2"><Select label="Primary outreach goal" placeholder="Select a goal" options={[...OUTREACH_GOAL_OPTIONS]} value={state.primaryGoal} onChange={(e) => setState({ ...state, primaryGoal: e.target.value })} required {...fieldProps('primaryGoal')} />{errorFor('primaryGoal')}</div></div></>
}

function PreferencesStep({ state, setState, errorFor, fieldProps }: StepProps) {
  return <><StepHeading icon={Globe2} eyebrow="Outreach preferences" title="Choose your starting market" description="This uses ReachAgent’s existing active-city setting. Campaign and category rules will be configured separately." /><div className="max-w-xl"><Input label="Primary city or market" placeholder="e.g. Sydney" value={state.primaryMarket} onChange={(e) => setState({ ...state, primaryMarket: e.target.value })} required maxLength={120} {...fieldProps('primaryMarket')} />{errorFor('primaryMarket')}<p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">You can add more cities and detailed targeting from Settings after setup.</p></div></>
}

function optionLabel(options: readonly { value: string; label: string }[], value: string) { return options.find((option) => option.value === value)?.label ?? value }

function Ready({ state }: { state: OnboardingState }) {
  const rows = [
    ['Workspace', state.workspaceName],
    ['Industry', optionLabel(INDUSTRY_OPTIONS, state.industry)],
    ['Outreach identity', `${state.senderName} · ${state.brandName}`],
    ['Primary goal', optionLabel(OUTREACH_GOAL_OPTIONS, state.primaryGoal)],
    ['Starting market', state.primaryMarket],
  ]
  return <><StepHeading icon={Rocket} eyebrow="Ready" title="Your workspace is ready" description="Review the essentials below, then enter ReachAgent. Your setup will remain editable as the workspace evolves." /><dl className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-hover)] px-4">{rows.map(([label, value]) => <div key={label} className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr]"><dt className="text-xs font-medium text-[var(--text-muted)]">{label}</dt><dd className="text-sm font-medium text-[var(--text-primary)]">{value}</dd></div>)}</dl><div className="mt-5 rounded-xl border border-[var(--primary-border)] bg-[var(--primary-muted)] p-4"><div className="flex gap-3"><Check size={18} className="mt-0.5 shrink-0 text-[var(--primary)]" /><div><p className="text-sm font-semibold text-[var(--text-primary)]">What comes next</p><p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">Campaign and category setup, mailbox connection, and team members remain separate steps. Nothing will send or run automatically when you enter ReachAgent.</p></div></div></div></>
}
