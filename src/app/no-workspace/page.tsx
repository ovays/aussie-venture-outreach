import { requireUser } from '@/lib/auth'

export default async function NoWorkspacePage() {
  await requireUser()

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl items-center px-6 py-16">
      <div className="w-full rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Workspace access required</h1>
        <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          Your account is not currently connected to an active workspace. Ask a workspace owner to invite you, or contact support to continue setup.
        </p>
      </div>
    </main>
  )
}
