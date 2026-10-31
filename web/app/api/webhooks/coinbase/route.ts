import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const sig = req.headers.get('x-cc-webhook-signature') ?? ''
  const secret = process.env.COINBASE_COMMERCE_WEBHOOK_SECRET ?? ''

  if (secret) {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
    if (expected !== sig) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  }

  let event: { event?: { type?: string; data?: { metadata?: { bet_id?: string } } } }
  try {
    event = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const eventType = event.event?.type
  if (eventType !== 'charge:confirmed') {
    // Acknowledge non-confirmation events without acting
    return NextResponse.json({ received: true })
  }

  const bet_id = event.event?.data?.metadata?.bet_id
  if (!bet_id) {
    console.error('[COINBASE WEBHOOK] charge:confirmed but no bet_id in metadata')
    return NextResponse.json({ error: 'No bet_id in metadata' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from('bets')
    .update({
      payment_status: 'confirmed',
      payment_confirmed_at: new Date().toISOString(),
    })
    .eq('id', bet_id)

  if (error) {
    console.error('[COINBASE WEBHOOK] update failed:', error)
    return NextResponse.json({ error: 'DB update failed' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}
