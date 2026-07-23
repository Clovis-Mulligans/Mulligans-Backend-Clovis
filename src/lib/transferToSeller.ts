import Stripe from 'stripe';
import { prisma } from './prisma';
import { sellerCanReceivePayout } from './escrowDecisions';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-11-17.clover',
});

export interface TransferToSellerParams {
  amountPence: number;
  seller: {
    id: string;
    stripe_connect_id: string | null;
    stripe_connect_status?: string | null;
  };
  idempotencyKey: string;
  metadata: Record<string, string>;
  orderIds: string[];
}

export type TransferToSellerResult =
  | { status: 'transferred';         transferId: string }
  | { status: 'already_transferred'; transferId: string }
  | { status: 'blocked';             reason: string }
  | { status: 'failed';              reason: string; code?: string };

export async function transferToSeller(params: TransferToSellerParams): Promise<TransferToSellerResult> {
  const { amountPence, seller, idempotencyKey, metadata, orderIds } = params;

  // 1. Double-transfer guard
  const existingOrders = await prisma.orders.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, stripe_transfer_id: true },
  });

  const alreadyTransferred = existingOrders.find(o => o.stripe_transfer_id !== null);
  if (alreadyTransferred) {
    return { status: 'already_transferred', transferId: alreadyTransferred.stripe_transfer_id! };
  }

  // 2. Payability guard
  if (!sellerCanReceivePayout(seller)) {
    const reason = !seller.stripe_connect_id
      ? 'no_stripe_connect_id'
      : `stripe_status_${seller.stripe_connect_status || 'null'}`;
    return { status: 'blocked', reason };
  }

  // 3. Validate amountPence
  if (!Number.isInteger(amountPence) || amountPence <= 0) {
    return { status: 'failed', reason: 'invalid_amount' };
  }

  // 4. Transfer via Stripe
  let transfer: Stripe.Transfer;
  try {
    transfer = await stripe.transfers.create(
      {
        amount: amountPence,
        currency: 'gbp',
        destination: seller.stripe_connect_id!,
        metadata,
      },
      { idempotencyKey },
    );
  } catch (error: any) {
    const code = error.code || error.type || 'unknown';
    console.error(
      `[TRANSFER] Failed for orders=${orderIds.join(',')} seller=${seller.id} code=${code} type=${error.type || 'unknown'} message=${error.message}`,
    );
    return { status: 'failed', reason: 'stripe_error', code };
  }

  // 5. Persist transfer ID (null-guarded write)
  const updateResult = await prisma.orders.updateMany({
    where: { id: { in: orderIds }, stripe_transfer_id: null },
    data: { stripe_transfer_id: transfer.id, updated_at: new Date() },
  });

  if (updateResult.count === 0) {
    console.error(
      `[TRANSFER] CRITICAL: Transfer ${transfer.id} succeeded but zero orders updated. orders=${orderIds.join(',')} seller=${seller.id}`,
    );
  }

  // 6. Return success
  return { status: 'transferred', transferId: transfer.id };
}
