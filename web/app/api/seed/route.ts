import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

/**
 * POST /api/seed
 * Creates a demo LULD halt for local testing when the market is closed.
 * Returns { halt_id, url } — visit the URL to place a test bet.
 *
 * Optional body: { symbol?, halt_price?, offset_minutes? }
 */
export async function POST(req: NextRequest) {
  let body: { symbol?: string; halt_price?: number; offset_minutes?: number } = {}
  try {
    body = await req.json()
  } catch {
    // No body is fine — use defaults
  }

  const symbol = (body.symbol ?? 'DEMO').toUpperCase()
  const halt_price = body.halt_price ?? 42.5
  const offsetMs = (body.offset_minutes ?? 0) * 60 * 1000

  const supabase = createServiceClient()

  // Find existing halt count for this symbol today to set halt_number
  const todayUtc = new Date().toISOString().slice(0, 10)
  const { data: existing } = await supabase
    .from('active_halts')
    .select('halt_id')
    .like('halt_id', `${symbol}-${todayUtc}-%`)

  const halt_number = (existing?.length ?? 0) + 1
  const halt_id = `${symbol}-${todayUtc}-${halt_number}`

  const now = new Date(Date.now() - offsetMs)
  const halt_time = now.toISOString()
  const closes_at = new Date(now.getTime() + 10 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('active_halts')
    .upsert(
      {
        halt_id,
        symbol,
        halt_number,
        halt_time,
        halt_price,
        reason_code: 'LUDP',
        pipeline_status: 'gate_open',
        is_active: true,
        t_halt_detected: halt_time,
        t_halt_price_set: halt_time,
        t_prediction_gate_open: halt_time,
        prediction_closes_at: closes_at,
        created_at: halt_time,
        updated_at: halt_time,
      },
      { onConflict: 'halt_id' },
    )
    .select('halt_id')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '')
  return NextResponse.json({
    halt_id: data.halt_id,
    url: `${appUrl}/predict/${data.halt_id}`,
    symbol,
    halt_price,
  })
}

/** GET /api/seed — list today's seeded demo halts */
export async function GET() {
  const supabase = createServiceClient()
  const todayUtc = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('active_halts')
    .select('halt_id,symbol,halt_price,is_active,pipeline_status,created_at')
    .like('halt_id', `%-${todayUtc}-%`)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
