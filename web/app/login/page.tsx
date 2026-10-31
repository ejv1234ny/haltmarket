'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase'

export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    const supabase = createClient()
    const sp = await searchParams
    const next = sp.next ? `?next=${encodeURIComponent(sp.next)}` : ''
    await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/api/auth/callback${next}`,
      },
    })
    setSent(true)
    setLoading(false)
  }

  if (sent) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <div className="max-w-sm w-full px-4 text-center space-y-3">
          <p className="text-2xl font-semibold">Check your email</p>
          <p className="text-zinc-400">
            Magic link sent to <span className="text-white font-medium">{email}</span>
          </p>
          <p className="text-zinc-600 text-sm">Click the link to sign in and make your prediction.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
      <div className="max-w-sm w-full px-4 space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">HaltMarket</h1>
          <p className="text-zinc-400 mt-1 text-sm">Sign in to make predictions</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoFocus
            className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-white text-black font-semibold rounded-xl py-3 disabled:opacity-40 hover:bg-zinc-100 transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            {loading ? 'Sending…' : 'Send magic link'}
          </button>
        </form>
        <p className="text-zinc-600 text-xs text-center">No password needed — we email you a one-click sign-in link.</p>
      </div>
    </div>
  )
}
