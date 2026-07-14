import Stripe from 'stripe';

export interface FailureRefundMetadata {
  reason: string;
  [key: string]: string;
}

export async function issueFailureRefund(
  stripe: Stripe,
  paymentIntentId: string,
  reason: string,
  metadata: FailureRefundMetadata,
): Promise<boolean> {
  try {
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      reason: 'requested_by_customer',
      metadata,
    }, {
      idempotencyKey: `fulfillment_refund_${paymentIntentId}`,
    });
    console.log(`[REFUND] Auto-refund issued: ${refund.id} for PI ${paymentIntentId} (${reason})`);
    return true;
  } catch (error: any) {
    console.error(`[CRITICAL] Auto-refund FAILED for PI ${paymentIntentId} (${reason}):`, error.message);
    return false;
  }
}
