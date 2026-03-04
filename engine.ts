// src/lib/trust/engine.ts
import { prisma } from '@/lib/prisma'
import { TrustChangeReason, TRUST_DELTAS, TRUST_THRESHOLDS } from '@/types'
import { auditLog } from '@/lib/audit/logger'

export async function applyTrustDelta(
  userId: string,
  reason: TrustChangeReason,
  customDelta?: number,
  note?: string,
  adminId?: string
): Promise<{ scoreBefore: number; scoreAfter: number }> {
  const delta = reason === 'ADMIN_ADJUSTMENT' && customDelta !== undefined
    ? customDelta
    : TRUST_DELTAS[reason]

  return await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } })
    if (!user) throw new Error('User not found')

    const scoreBefore = user.trustScore
    let scoreAfter = Math.max(-999, scoreBefore + delta) // floor at -999

    // Record history entry
    await tx.trustScoreHistory.create({
      data: {
        userId,
        delta,
        reason,
        scoreBefore,
        scoreAfter,
        note,
        createdBy: adminId,
      },
    })

    // Update user trust score
    const updatedUser = await tx.user.update({
      where: { id: userId },
      data: { trustScore: scoreAfter },
    })

    // Enforce auto-ban if score <= 0
    if (scoreAfter <= TRUST_THRESHOLDS.AUTO_BAN && user.status !== 'BANNED') {
      await tx.user.update({
        where: { id: userId },
        data: { status: 'BANNED' },
      })

      // Auto-ban all assets
      await tx.asset.updateMany({
        where: { ownerId: userId },
        data: { status: 'BANNED' },
      })

      // Flag all subscriptions
      await tx.subscription.updateMany({
        where: { subscriberId: userId, status: 'ACTIVE' },
        data: { status: 'FLAGGED' },
      })

      await auditLog(
        'USER_BANNED',
        adminId ?? 'system',
        userId,
        'user',
        { reason: 'Trust score auto-ban', trustScore: scoreAfter }
      )
    }

    // Restrict asset visibility if trust < 30 but not banned
    else if (
      scoreAfter < TRUST_THRESHOLDS.RESTRICT_VISIBILITY &&
      scoreBefore >= TRUST_THRESHOLDS.RESTRICT_VISIBILITY
    ) {
      await tx.asset.updateMany({
        where: { ownerId: userId, status: 'ACTIVE' },
        data: { status: 'HIDDEN' },
      })

      await auditLog(
        'ASSET_HIDDEN',
        adminId ?? 'system',
        userId,
        'user',
        { reason: 'Trust score below threshold', trustScore: scoreAfter }
      )
    }

    await auditLog(
      'TRUST_SCORE_CHANGED',
      adminId ?? 'system',
      userId,
      'user',
      { delta, reason, scoreBefore, scoreAfter, note }
    )

    return { scoreBefore, scoreAfter }
  })
}

export async function getTrustHistory(userId: string) {
  return prisma.trustScoreHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  })
}
