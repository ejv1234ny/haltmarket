'use client'

import { useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase'

interface Prediction {
  id: number
  predicted_price: number | null
  predicted_direction: string | null
  halt_price: number | null
  was_direction_correct: boolean | null
  actual_reopen_price: number | null
  elo_change: number | null
}

interface Props {
  halt_id: string
  halt_price: number | null
  prediction_closes_at: string | null
  existingPrediction: Prediction | null
}

export default function PredictClient({
  halt_id,
  halt_price,
  prediction_closes_at,
  existingPrediction,
}: Props) {
  const [prediction, setPrediction] = useState<Prediction | null>(existingPrediction)
  const [priceInput, setPriceInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const channelRef = useRef<RealtimeChannel | null>(null)

  const price = parseFloat(priceInput)
  const validPrice = !isNaN(price) && price > 0 && halt_price != null && price !== halt_price
  const direction = validPrice && halt_price != null ? (price > halt_price ? 'UP' : 'DOWN') : null
  const gapPct = validPrice && halt_price != null ? ((price - halt_price) / halt_price * 100) : null

  const windowClosed = prediction_closes_at ? new Date() > new Date(prediction_closes_at) : false

  // Realtime subscription — watches for resume_price to populate
  useEffect(() => {
    if (prediction?.was_direction_correct != null) return  // already scored

    const supabase = createClient()
    const channel = supabase
      .channel(`halt-${halt_id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'active_halts',
          filter: `halt_id=eq.${halt_id}`,
        },
        () => {
          // Refresh the page to pick up server-rendered resolved state
          window.location.reload()
        },
      )
      .subscribe()

    channelRef.current = channel
    return () => { supabase.removeChannel(channel) }
  }, [halt_id, prediction?.was_direction_correct])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const resp = await fetch(`/api/predict/${halt_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ predicted_price: parseFloat(priceInput) }),
      })
      const data = await resp.json()
      if (resp.status === 401) {
        window.location.href = `/login?next=/predict/${halt_id}`
        return
      }
      if (!resp.ok) {
        setError(data.error || 'Something went wrong')
        return
      }
      setPrediction(data.prediction)
    } catch {
      setError('Network error — please try again')
    } finally {
      setLoading(false)
    }
  }

  // LOCKED state — user has submitted, waiting for resolve
  if (prediction) {
    return (
      <div className="space-y-4">
        <div className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800 space-y-3">
          <p className="text-zinc-500 text-xs uppercase tracking-wider">Your prediction</p>
          <div className="flex items-baseline gap-2">
            <span className={`text-3xl font-bold ${prediction.predicted_direction === 'UP' ? 'text-emerald-400' : 'text-red-400'}`}>
              {prediction.predicted_direction === 'UP' ? '↑' : '↓'} ${prediction.predicted_price?.toFixed(2)}
            </span>
          </div>
          {halt_price != null && prediction.predicted_price != null && (
            <p className="text-zinc-500 text-sm">
              {prediction.predicted_direction} {Math.abs(((prediction.predicted_price - halt_price) / halt_price) * 100).toFixed(1)}% from ${halt_price.toFixed(2)}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 text-zinc-500 text-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
          Waiting for halt to resolve…
        </div>
      </div>
    )
  }

  // No halt price yet
  if (!halt_price) {
    return (
      <div className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800">
        <p className="text-zinc-400">Fetching halt price from Polygon…</p>
        <p className="text-zinc-600 text-sm mt-1">Refresh in a few seconds.</p>
      </div>
    )
  }

  // Window closed, no prediction made
  if (windowClosed) {
    return (
      <div className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800">
        <p className="text-zinc-400 font-medium">Prediction window closed</p>
        <p className="text-zinc-600 text-sm mt-1">This halt's prediction window has ended.</p>
      </div>
    )
  }

  // OPEN state — take prediction
  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {direction && gapPct !== null && (
        <div className={`rounded-xl px-4 py-3 text-sm font-semibold border ${
          direction === 'UP'
            ? 'bg-emerald-950 border-emerald-800 text-emerald-300'
            : 'bg-red-950 border-red-900 text-red-300'
        }`}>
          {direction === 'UP' ? '↑' : '↓'} {direction}{' '}
          {gapPct > 0 ? '+' : ''}{gapPct.toFixed(1)}% from ${halt_price.toFixed(2)}
        </div>
      )}

      <div>
        <label className="block text-zinc-400 text-sm mb-1.5">Your reopen price prediction</label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none">$</span>
          <input
            type="number"
            step="0.01"
            min="0.01"
            placeholder="0.00"
            value={priceInput}
            onChange={e => setPriceInput(e.target.value)}
            required
            autoFocus
            className="w-full bg-zinc-900 border border-zinc-700 rounded-xl pl-7 pr-4 py-3 text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
          />
        </div>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <button
        type="submit"
        disabled={loading || !validPrice}
        className="w-full bg-white text-black font-semibold rounded-xl py-3 mt-2 disabled:opacity-40 hover:bg-zinc-100 transition-colors cursor-pointer disabled:cursor-not-allowed"
      >
        {loading ? 'Locking in…' : 'Lock in prediction'}
      </button>

      {prediction_closes_at && (
        <p className="text-zinc-600 text-xs text-center">
          Window closes {new Date(prediction_closes_at).toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short',
          })}
        </p>
      )}
    </form>
  )
}
