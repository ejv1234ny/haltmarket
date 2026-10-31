import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createUserClient } from '@/lib/supabase-server'

type Params = Promise<{ halt_id: string }>

export async function GET(req: NextRequest, { params }: { params: Params }) {
  const { halt_id } = await params
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('active_halts')
    .select(
      'halt_id,symbol,halt_number,halt_time,halt_price,resume_price,' +
      'reopen_direction,reopen_gap_pct,is_active,prediction_closes_at,' +
      'pipeline_status,reason_code',
    )
    .eq('halt_id', halt_id)
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Halt not found' }, { status: 404 })
  }
  return NextResponse.json(data)
}

export async function POST(req: NextRequest, { params }: { params: Params }) {
  const { halt_id } = await params

  // Auth check
  const userClient = await createUserClient()
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 })
  }

  let body: { predicted_price?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { predicted_price } = body
  if (!predicted_price || predicted_price <= 0) {
    return NextResponse.json({ error: 'predicted_price must be a positive number' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Fetch halt
  const { data: halt, error: haltErr } = await supabase
    .from('active_halts')
    .select('halt_price,halt_number,is_active,prediction_closes_at')
    .eq('halt_id', halt_id)
    .single()

  if (haltErr || !halt) {
    return NextResponse.json({ error: 'Halt not found' }, { status: 404 })
  }
  if (!halt.is_active) {
    return NextResponse.json({ error: 'This halt has already resolved' }, { status: 400 })
  }
  if (!halt.halt_price) {
    return NextResponse.json({ error: 'Halt price not yet available — try again in a moment' }, { status: 400 })
  }
  if (predicted_price === halt.halt_price) {
    return NextResponse.json({ error: 'Predicted price cannot equal the halt price' }, { status: 400 })
  }

  // Check prediction window
  if (halt.prediction_closes_at && new Date() > new Date(halt.prediction_closes_at)) {
    return NextResponse.json({ error: 'Prediction window has closed' }, { status: 400 })
  }

  const symbol = halt_id.split('-')[0]
  const predicted_direction = predicted_price > halt.halt_price ? 'UP' : 'DOWN'

  // Insert into user_predictions — handle duplicate gracefully
  const { data: prediction, error: insertErr } = await supabase
    .from('user_predictions')
    .insert({
      user_id: user.id,
      halt_id,
      symbol,
      halt_number: halt.halt_number,
      halt_price: halt.halt_price,
      predicted_price,
      predicted_direction,
    })
    .select('id,predicted_price,predicted_direction,halt_price')
    .single()

  if (insertErr) {
    if (insertErr.code === '23505') {
      // Already predicted — return existing
      const { data: existing } = await supabase
        .from('user_predictions')
        .select('id,predicted_price,predicted_direction,halt_price,was_direction_correct,actual_reopen_price')
        .eq('halt_id', halt_id)
        .eq('user_id', user.id)
        .single()
      return NextResponse.json({ prediction: existing, duplicate: true })
    }
    console.error('[PREDICT INSERT]', insertErr)
    return NextResponse.json({ error: insertErr.message }, { status: 500 })
  }

  return NextResponse.json({ prediction }, { status: 201 })
}
