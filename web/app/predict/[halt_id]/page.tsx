import { redirect } from 'next/navigation'
import { createServiceClient, createUserClient } from '@/lib/supabase-server'
import PredictClient from './PredictClient'

interface HaltRow {
  halt_id: string
  symbol: string
  halt_number: number
  halt_time: string
  halt_price: number | null
  resume_price: number | null
  reopen_direction: string | null
  reopen_gap_pct: number | null
  is_active: boolean
  prediction_closes_at: string | null
  pipeline_status: string
  reason_code: string
}

interface PredictionRow {
  id: number
  predicted_price: number | null
  predicted_direction: string | null
  halt_price: number | null
  was_direction_correct: boolean | null
  actual_reopen_price: number | null
  elo_change: number | null
}

interface Props {
  params: Promise<{ halt_id: string }>
}

function formatTime(isoStr: string): string {
  try {
    return new Date(isoStr).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
      timeZoneName: 'short',
    })
  } catch {
    return isoStr
  }
}

export default async function PredictPage({ params }: Props) {
  const { halt_id } = await params

  // Auth check — redirect to login preserving destination
  const userClient = await createUserClient()
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) {
    redirect(`/login?next=/predict/${halt_id}`)
  }

  const supabase = createServiceClient()

  const [haltResult, predResult] = await Promise.all([
    supabase
      .from('active_halts')
      .select(
        'halt_id,symbol,halt_number,halt_time,halt_price,resume_price,' +
        'reopen_direction,reopen_gap_pct,is_active,prediction_closes_at,' +
        'pipeline_status,reason_code',
      )
      .eq('halt_id', halt_id)
      .single(),
    supabase
      .from('user_predictions')
      .select('id,predicted_price,predicted_direction,halt_price,was_direction_correct,actual_reopen_price,elo_change')
      .eq('halt_id', halt_id)
      .eq('user_id', user.id)
      .maybeSingle(),
  ])

  const halt = haltResult.data as HaltRow | null
  const existingPrediction = predResult.data as PredictionRow | null

  if (!halt) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-zinc-300 font-medium">Halt not found</p>
          <p className="text-zinc-600 text-sm font-mono">{halt_id}</p>
        </div>
      </div>
    )
  }

  const isResolved =
    halt.resume_price != null ||
    halt.pipeline_status === 'complete' ||
    halt.pipeline_status === 'resolved'

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-md mx-auto px-4 py-12">

        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-2">
            {isResolved ? (
              <span className="text-xs font-semibold tracking-widest text-emerald-400 uppercase">Resolved</span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-semibold tracking-widest text-red-400 uppercase">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                Live Halt
              </span>
            )}
            {halt.halt_number > 1 && (
              <span className="text-zinc-600 text-xs">Halt #{halt.halt_number} today</span>
            )}
          </div>

          <h1 className="text-5xl font-bold tracking-tight">{halt.symbol}</h1>

          <div className="mt-2 flex items-baseline gap-2 flex-wrap">
            <span className="text-zinc-400">
              Halted at{' '}
              <span className="text-white font-semibold">
                ${halt.halt_price != null ? halt.halt_price.toFixed(2) : '—'}
              </span>
            </span>
            <span className="text-zinc-600 text-sm">
              {halt.halt_time ? formatTime(halt.halt_time) : ''} · NASDAQ · {halt.reason_code}
            </span>
          </div>
        </div>

        {/* Resolved result card */}
        {isResolved ? (
          <div className="space-y-4">
            <div className="bg-zinc-900 rounded-2xl p-6 border border-zinc-800 space-y-2">
              <p className="text-zinc-500 text-xs uppercase tracking-wider">Final result</p>
              <div className="flex items-baseline gap-3">
                <span className={`text-4xl font-bold ${halt.reopen_direction === 'UP' ? 'text-emerald-400' : 'text-red-400'}`}>
                  {halt.reopen_direction === 'UP' ? '↑' : '↓'} {halt.reopen_direction}
                </span>
                <span className="text-zinc-400 text-xl">
                  {halt.reopen_gap_pct != null
                    ? `${halt.reopen_gap_pct > 0 ? '+' : ''}${halt.reopen_gap_pct.toFixed(1)}%`
                    : ''}
                </span>
              </div>
              <p className="text-zinc-500">
                ${halt.halt_price?.toFixed(2)} →{' '}
                <span className="text-white font-medium">${halt.resume_price?.toFixed(2)}</span>
              </p>
            </div>

            {existingPrediction?.was_direction_correct != null && (
              <div className={`rounded-2xl p-4 border ${existingPrediction.was_direction_correct ? 'bg-emerald-950 border-emerald-800' : 'bg-red-950 border-red-900'}`}>
                <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Your call</p>
                <p className="font-semibold">
                  ${existingPrediction.predicted_price?.toFixed(2)} — {existingPrediction.predicted_direction}
                  {' '}
                  {existingPrediction.was_direction_correct
                    ? <span className="text-emerald-400">✓ Correct</span>
                    : <span className="text-red-400">✗ Wrong</span>}
                </p>
                {existingPrediction.elo_change != null && (
                  <p className="text-sm text-zinc-400 mt-0.5">
                    ELO {existingPrediction.elo_change > 0 ? '+' : ''}{existingPrediction.elo_change}
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <PredictClient
            halt_id={halt_id}
            halt_price={halt.halt_price}
            prediction_closes_at={halt.prediction_closes_at}
            existingPrediction={existingPrediction}
          />
        )}

      </div>
    </div>
  )
}
