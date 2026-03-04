// src/app/api/stripe/webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { verifyWebhookSignature } from '@/lib/stripe/client'
import { prisma } from '@/lib/prisma'
import { applyTrustDelta } from '@/lib/trust/engine'

export const config = {
  api: { bodyParser: false },
}

export async function POST(req: NextRequest) {
  const signature = req.headers.get('stripe-signature')
  if (!signature) {
    return NextResponse.json({ error: 'No signature' }, { status: 400 })
  }

  let rawBody: string
  try {
    rawBody = await req.text()
  } catch {
    return NextResponse.json({ error: 'Failed to read body' }, { status: 400 })
  }

  let event: Stripe.Event
  try {
    event = verifyWebhookSignature(rawBody, signature)
  } catch (err: any) {
    console.error('[Webhook] Signature verification failed:', err.message)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  try {
    switch (event.type) {
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object as Stripe.Invoice)
        break
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.Invoice)
        break
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription)
        break
      default:
        // Ignore unhandled events
        break
    }
  } catch (err) {
    console.error('[Webhook] Handler error:', err)
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}

async function handlePaymentSucceeded(invoice: Stripe.Invoice) {
  if (!invoice.subscription) return

  const stripeSubId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : invoice.subscription.id

  // Idempotency check
  const idempotencyKey = `succeeded:${invoice.id}`
  const existing = await prisma.invoice.findUnique({ where: { idempotencyKey } })
  if (existing) return // Already processed

  const sub = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId: stripeSubId },
    include: { asset: true, subscriber: true },
  })
  if (!sub) return

  await prisma.$transaction(async (tx) => {
    // Activate subscription
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        status: 'ACTIVE',
        currentPeriodStart: new Date(invoice.period_start * 1000),
        currentPeriodEnd: new Date(invoice.period_end * 1000),
      },
    })

    // Record invoice (idempotency)
    await tx.invoice.create({
      data: {
        subscriptionId: sub.id,
        stripeInvoiceId: invoice.id,
        amount: invoice.amount_paid / 100,
        status: 'paid',
        idempotencyKey,
      },
    })
  })

  // +5 trust to asset owner per successful billing cycle
  await applyTrustDelta(
    sub.asset.ownerId,
    'BILLING_SUCCESS',
    undefined,
    `Invoice ${invoice.id} paid successfully`
  )
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  if (!invoice.subscription) return

  const stripeSubId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : invoice.subscription.id

  const idempotencyKey = `failed:${invoice.id}`
  const existing = await prisma.invoice.findUnique({ where: { idempotencyKey } })
  if (existing) return

  const sub = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId: stripeSubId },
  })
  if (!sub) return

  await prisma.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: sub.id },
      data: { status: 'PAST_DUE' },
    })

    await tx.invoice.create({
      data: {
        subscriptionId: sub.id,
        stripeInvoiceId: invoice.id,
        amount: invoice.amount_due / 100,
        status: 'failed',
        idempotencyKey,
      },
    })
  })
}

async function handleSubscriptionDeleted(stripeSub: Stripe.Subscription) {
  const sub = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId: stripeSub.id },
  })
  if (!sub) return

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { status: 'CANCELLED' },
  })
}
