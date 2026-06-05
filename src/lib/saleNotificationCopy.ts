type AutoLabelSkippedReason = 'no_valid_address' | 'seller_not_verified' | 'no_tracked_rate' | string | null | undefined;

interface SaleNotificationCopy {
  title: string;
  body: string;
  type: 'sale_label_ready' | 'sale_action_required';
}

export function getSaleNotificationCopy(
  allLabelsReady: boolean,
  skippedReason: AutoLabelSkippedReason,
): SaleNotificationCopy {
  if (allLabelsReady) {
    return {
      title: 'Items sold!',
      body: 'Your shipping labels are ready. Tap to view your QR codes.',
      type: 'sale_label_ready',
    };
  }

  switch (skippedReason) {
    case 'no_valid_address':
      return {
        title: 'Items sold — add your address',
        body: 'Add your sending address to create a shipping label and ship your order.',
        type: 'sale_action_required',
      };
    case 'seller_not_verified':
      return {
        title: 'Items sold — verify to ship',
        body: 'Complete your Stripe verification to create a shipping label.',
        type: 'sale_action_required',
      };
    default:
      return {
        title: 'Items sold — action needed',
        body: 'Tap to complete shipping details for your sales.',
        type: 'sale_action_required',
      };
  }
}
