import { prisma } from './prisma';

export async function sellerIsPayoutReady(userId: string): Promise<{ ready: boolean; reason?: string }> {
  const seller = await prisma.users.findUnique({
    where: { id: userId },
    select: { stripe_connect_id: true, stripe_connect_status: true },
  });

  if (!seller) {
    return { ready: false, reason: 'seller_not_found' };
  }

  if (!seller.stripe_connect_id || seller.stripe_connect_status !== 'active') {
    return { ready: false, reason: 'payout_not_ready' };
  }

  return { ready: true };
}
