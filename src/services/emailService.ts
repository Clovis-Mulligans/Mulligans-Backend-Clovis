// src/services/emailService.ts
import { Resend } from 'resend';
import fs from 'fs';
import path from 'path';

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_ADDRESS = 'Mulligans <hello@mail.mulligans.uk.com>';
const ADMIN_EMAIL = 'info@mulligans.uk.com';

function loadTemplate(templateName: string, variables: Record<string, string>): string {
  // Path goes from dist/services/ up to project root, then into src/email-templates/
  const templatePath = path.join(__dirname, '../../src/email-templates', `${templateName}.html`);
  let html = fs.readFileSync(templatePath, 'utf-8');
  
  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    html = html.replace(regex, value || '');
  });
  
  return html;
}

// ============================================
// AUTHENTICATION EMAILS
// ============================================

export async function sendVerificationEmail(userEmail: string, code: string): Promise<void> {
  const html = loadTemplate('verification-email', { code });
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: userEmail,
    subject: 'Verify Your Email - Mulligans',
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send verification email:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Verification email sent to ${userEmail}`);
}

export async function sendPasswordResetEmail(userEmail: string, code: string): Promise<void> {
  const html = loadTemplate('password-reset', { code });
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: userEmail,
    subject: 'Reset Your Password - Mulligans',
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send password reset email:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Password reset email sent to ${userEmail}`);
}

export async function sendWelcomeEmail(userEmail: string, userName: string): Promise<void> {
  const html = loadTemplate('welcome-email', { userName });
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: userEmail,
    subject: 'Welcome to Mulligans!',
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send welcome email:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Welcome email sent to ${userEmail}`);
}

// ============================================
// BUYER EMAILS
// ============================================

export async function sendOrderConfirmation(buyerEmail: string, data: Record<string, string>): Promise<void> {
  const html = loadTemplate('order-confirmation', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: buyerEmail,
    subject: `Order Confirmed - #${data.orderId}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send order confirmation:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Order confirmation sent to ${buyerEmail}`);
}

export async function sendShippingNotification(buyerEmail: string, data: Record<string, string>): Promise<void> {
  const html = loadTemplate('shipping-notification', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: buyerEmail,
    subject: `Your Order Has Shipped - #${data.orderNumber}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send shipping notification:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Shipping notification sent to ${buyerEmail}`);
}

export async function sendDeliveryConfirmation(buyerEmail: string, data: Record<string, string>): Promise<void> {
  const html = loadTemplate('delivery-confirmation', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: buyerEmail,
    subject: `Your Order Has Been Delivered - #${data.orderNumber}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send delivery confirmation:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Delivery confirmation sent to ${buyerEmail}`);
}

export async function sendReviewReminder(buyerEmail: string, data: Record<string, string>): Promise<void> {
  const html = loadTemplate('review-reminder', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: buyerEmail,
    subject: `How Was Your Purchase? - Mulligans`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send review reminder:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Review reminder sent to ${buyerEmail}`);
}

// ============================================
// SELLER EMAILS
// ============================================

export async function sendSaleNotification(sellerEmail: string, data: Record<string, string>): Promise<void> {
  const html = loadTemplate('sale-notification', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: sellerEmail,
    subject: `🎉 You Made a Sale! - #${data.orderNumber}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send sale notification:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Sale notification sent to ${sellerEmail}`);
}

export async function sendEscrowReleased(sellerEmail: string, data: Record<string, string>): Promise<void> {
  const html = loadTemplate('escrow-released', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: sellerEmail,
    subject: `💰 Payment Released - #${data.orderNumber}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send escrow released email:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Escrow released notification sent to ${sellerEmail}`);
}

// ============================================
// RETURN EMAILS
// ============================================

export async function sendReturnAddressNeeded(
  sellerEmail: string,
  data: {
    sellerName: string;
    itemTitle: string;
    orderNumber: string;
    buyerName: string;
  }
): Promise<void> {
  const html = loadTemplate('return-address-needed', {
    sellerName: data.sellerName,
    itemTitle: data.itemTitle,
    orderNumber: data.orderNumber,
    buyerName: data.buyerName,
  });
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: sellerEmail,
    subject: `⚠️ Action Required: Complete Stripe Setup for Return - ${data.itemTitle}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send return address needed email:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Return address needed email sent to ${sellerEmail}`);
}

// ============================================
// DISPUTE EMAILS
// ============================================

// Helper to format reason type for display
function formatReasonType(reasonType: string): string {
  const map: Record<string, string> = {
    'not_as_described': 'Item not as described',
    'damaged': 'Item arrived damaged',
    'wrong_item': 'Wrong item received',
    'counterfeit': 'Item appears counterfeit',
    'missing_parts': 'Missing parts or accessories',
    'other': 'Other issue',
  };
  return map[reasonType] || reasonType;
}

// Helper to format date for display
function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// 1. Notify seller that a dispute has been opened
export async function sendDisputeOpenedToSeller(
  sellerEmail: string,
  data: {
    sellerName: string;
    buyerName: string;
    itemTitle: string;
    orderNumber: string;
    reasonType: string;
    reasonText: string;
    refundAmount: string;
    refundPercent: string;
    deadline: Date;
  }
): Promise<void> {
  const html = loadTemplate('dispute-opened-seller', {
    sellerName: data.sellerName,
    buyerName: data.buyerName,
    itemTitle: data.itemTitle,
    orderNumber: data.orderNumber,
    reasonType: formatReasonType(data.reasonType),
    reasonText: data.reasonText || 'No additional details provided',
    refundAmount: data.refundAmount,
    refundPercent: data.refundPercent,
    deadline: formatDate(data.deadline),
  });
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: sellerEmail,
    subject: `⚠️ Dispute Opened - ${data.itemTitle}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send dispute opened email to seller:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Dispute opened email sent to seller ${sellerEmail}`);
}

// 2. Confirm to buyer that their dispute was submitted
export async function sendDisputeOpenedToBuyer(
  buyerEmail: string,
  data: {
    buyerName: string;
    sellerName: string;
    itemTitle: string;
    orderNumber: string;
    reasonType: string;
    reasonText: string;
    refundAmount: string;
    refundPercent: string;
  }
): Promise<void> {
  const html = loadTemplate('dispute-opened-buyer', {
    buyerName: data.buyerName,
    sellerName: data.sellerName,
    itemTitle: data.itemTitle,
    orderNumber: data.orderNumber,
    reasonType: formatReasonType(data.reasonType),
    reasonText: data.reasonText || 'No additional details provided',
    refundAmount: data.refundAmount,
    refundPercent: data.refundPercent,
  });
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: buyerEmail,
    subject: `Dispute Submitted - ${data.itemTitle}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send dispute confirmation to buyer:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Dispute confirmation sent to buyer ${buyerEmail}`);
}

// 3. Notify buyer of seller's response (counter offer or rejection)
export async function sendDisputeResponseToBuyer(
  buyerEmail: string,
  data: {
    buyerName: string;
    itemTitle: string;
    orderNumber: string;
    isCounterOffer: boolean;
    counterOfferAmount?: string;
    sellerMessage: string;
  }
): Promise<void> {
  // Set colors and text based on response type
  let responseType: string;
  let responseBackground: string;
  let responseBorder: string;
  let responseColor: string;
  let counterOfferSection: string;
  
  if (data.isCounterOffer && data.counterOfferAmount) {
    responseType = 'Counter Offer';
    responseBackground = '#ecfdf5';
    responseBorder = '#1DC690';
    responseColor = '#065f46';
    counterOfferSection = `
      <p style="margin: 0 0 16px 0; font-size: 14px; color: #374151;"><strong>Offered Amount:</strong></p>
      <p style="margin: 0 0 16px 0; font-size: 24px; font-weight: 700; color: #1DC690;">£${data.counterOfferAmount}</p>
    `;
  } else {
    responseType = 'Claim Rejected';
    responseBackground = '#fef2f2';
    responseBorder = '#fecaca';
    responseColor = '#991b1b';
    counterOfferSection = '';
  }
  
  const html = loadTemplate('dispute-response-buyer', {
    buyerName: data.buyerName,
    itemTitle: data.itemTitle,
    orderNumber: data.orderNumber,
    responseType: responseType,
    responseBackground: responseBackground,
    responseBorder: responseBorder,
    responseColor: responseColor,
    counterOfferSection: counterOfferSection,
    sellerMessage: data.sellerMessage || 'No message provided',
  });
  
  const subject = data.isCounterOffer 
    ? `💬 Counter Offer Received - ${data.itemTitle}`
    : `💬 Seller Responded - ${data.itemTitle}`;
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: buyerEmail,
    subject: subject,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send dispute response to buyer:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Dispute response sent to buyer ${buyerEmail}`);
}

// 4. Notify admin of escalated dispute
export async function sendDisputeEscalatedToAdmin(
  data: {
    disputeId: string;
    itemTitle: string;
    refundAmount: string;
    buyerName: string;
    buyerEmail: string;
    sellerName: string;
    sellerEmail: string;
    reasonType: string;
    escalationReason: string;
  }
): Promise<void> {
  const html = loadTemplate('dispute-escalated-admin', {
    disputeId: data.disputeId,
    itemTitle: data.itemTitle,
    refundAmount: data.refundAmount,
    buyerName: data.buyerName,
    buyerEmail: data.buyerEmail,
    sellerName: data.sellerName,
    sellerEmail: data.sellerEmail,
    reasonType: formatReasonType(data.reasonType),
    escalationReason: data.escalationReason,
  });
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: ADMIN_EMAIL,
    subject: `🚨 Escalated Dispute - Review Required - ${data.disputeId.slice(-8)}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send escalation email to admin:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Escalation email sent to admin`);
}

// 5. Confirm to buyer that their escalation was received
export async function sendDisputeEscalatedToBuyer(
  buyerEmail: string,
  data: {
    buyerName: string;
    itemTitle: string;
    orderNumber: string;
    refundAmount: string;
  }
): Promise<void> {
  const html = loadTemplate('dispute-escalated-buyer', {
    buyerName: data.buyerName,
    itemTitle: data.itemTitle,
    orderNumber: data.orderNumber,
    refundAmount: data.refundAmount,
  });
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: buyerEmail,
    subject: `🔍 Dispute Under Review - ${data.itemTitle}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send escalation confirmation to buyer:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Escalation confirmation sent to buyer ${buyerEmail}`);
}

// 6. Send resolution notification to a party (buyer or seller)
export async function sendDisputeResolved(
  email: string,
  data: {
    userName: string;
    itemTitle: string;
    orderNumber: string;
    resolutionType: 'full_refund' | 'partial_refund' | 'no_refund';
    refundAmount?: string;
    adminNotes: string;
    isBuyer: boolean;
  }
): Promise<void> {
  // Set colors and content based on resolution type and recipient
  let decisionTitle: string;
  let decisionBackground: string;
  let decisionBorder: string;
  let decisionColor: string;
  let refundAmountSection: string;
  let nextSteps: string;
  
  switch (data.resolutionType) {
    case 'full_refund':
      decisionTitle = 'Full Refund Approved';
      decisionBackground = '#ecfdf5';
      decisionBorder = '#1DC690';
      decisionColor = '#065f46';
      refundAmountSection = data.refundAmount 
        ? `<p style="margin: 0; font-size: 28px; font-weight: 700; color: #1DC690;">£${data.refundAmount}</p>`
        : '';
      nextSteps = data.isBuyer
        ? 'The full purchase amount will be refunded to your original payment method within 5-10 business days.'
        : 'The full purchase amount has been refunded to the buyer. No further action is required from you.';
      break;
      
    case 'partial_refund':
      decisionTitle = 'Partial Refund Approved';
      decisionBackground = '#eff6ff';
      decisionBorder = '#3b82f6';
      decisionColor = '#1e40af';
      refundAmountSection = data.refundAmount 
        ? `<p style="margin: 0; font-size: 28px; font-weight: 700; color: #3b82f6;">£${data.refundAmount}</p>`
        : '';
      nextSteps = data.isBuyer
        ? `A partial refund of £${data.refundAmount} will be processed to your original payment method within 5-10 business days.`
        : `A partial refund of £${data.refundAmount} has been issued to the buyer. This amount has been deducted from your payout.`;
      break;
      
    case 'no_refund':
    default:
      decisionTitle = 'No Refund Warranted';
      decisionBackground = '#f9fafb';
      decisionBorder = '#d1d5db';
      decisionColor = '#374151';
      refundAmountSection = '';
      nextSteps = data.isBuyer
        ? 'After reviewing all evidence, we determined that a refund is not warranted in this case. The order is now considered complete.'
        : 'After reviewing all evidence, we determined that the buyer\'s claim was not valid. Your full payout will be released as normal.';
      break;
  }
  
  const html = loadTemplate('dispute-resolved', {
    userName: data.userName,
    itemTitle: data.itemTitle,
    orderNumber: data.orderNumber,
    decisionTitle: decisionTitle,
    decisionBackground: decisionBackground,
    decisionBorder: decisionBorder,
    decisionColor: decisionColor,
    refundAmountSection: refundAmountSection,
    adminNotes: data.adminNotes,
    nextSteps: nextSteps,
  });
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: email,
    subject: `⚖️ Dispute Resolved - ${data.itemTitle}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send dispute resolution email:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Dispute resolution sent to ${email}`);
}

// Legacy function for backwards compatibility (can be removed later)
export async function sendDisputeEmail(
  to: string,
  subject: string,
  html: string
): Promise<void> {
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: to,
    subject: subject,
    html: html,
  });

  if (error) {
    console.error('❌ Failed to send dispute email:', error);
    throw new Error(error.message);
  }

  console.log(`✅ Dispute email sent to ${to}`);
}

// ============================================
// RETURN EMAILS
// ============================================

export async function sendReturnLabelCreated(
  recipientEmail: string,
  data: {
    recipientName: string;
    itemTitle: string;
    carrier: string;
    trackingNumber: string;
    message: string;
  }
): Promise<void> {
  const html = loadTemplate('return-label-created', {
    recipientName: data.recipientName,
    itemTitle: data.itemTitle,
    carrier: data.carrier,
    trackingNumber: data.trackingNumber,
    message: data.message,
  });
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: recipientEmail,
    subject: `🏷️ Return Label Created - ${data.itemTitle}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send return label created email:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Return label created email sent to ${recipientEmail}`);
}

export async function sendReturnShipped(
  sellerEmail: string,
  data: {
    sellerName: string;
    itemTitle: string;
    carrier: string;
    trackingNumber: string;
  }
): Promise<void> {
  const html = loadTemplate('return-shipped', {
    sellerName: data.sellerName,
    itemTitle: data.itemTitle,
    carrier: data.carrier,
    trackingNumber: data.trackingNumber,
  });
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: sellerEmail,
    subject: `📦 Return Item Shipped - ${data.itemTitle}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send return shipped email:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Return shipped email sent to ${sellerEmail}`);
}

export async function sendReturnRefundProcessed(
  buyerEmail: string,
  data: {
    buyerName: string;
    itemTitle: string;
    refundAmount: string;
    shippingDeducted?: string;
    orderNumber: string;
  }
): Promise<void> {
  // Build shipping note if there was a deduction
  let shippingNote = '';
  if (data.shippingDeducted && parseFloat(data.shippingDeducted) > 0) {
    shippingNote = `<p style="margin: 8px 0 0 0; font-size: 12px; color: #065f46;">(£${data.shippingDeducted} return shipping deducted)</p>`;
  }

  const html = loadTemplate('return-refund-processed', {
    buyerName: data.buyerName,
    itemTitle: data.itemTitle,
    refundAmount: data.refundAmount,
    shippingNote: shippingNote,
    orderNumber: data.orderNumber,
  });
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: buyerEmail,
    subject: `✅ Refund Processed - ${data.itemTitle}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send refund processed email:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Refund processed email sent to ${buyerEmail}`);
}
// ============================================
// INSURANCE CLAIM EMAILS
// ============================================

export async function sendInsuranceClaimApprovedToBuyer(
  buyerEmail: string,
  data: {
    buyerName: string;
    itemTitle: string;
    refundAmount: string;
    orderNumber: string;
  }
): Promise<void> {
  const html = loadTemplate('insurance-claim-approved-buyer', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: buyerEmail,
    subject: `✅ Lost Item Claim Approved - ${data.itemTitle}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send claim approved email to buyer:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Claim approved email sent to buyer: ${buyerEmail}`);
}

export async function sendInsuranceClaimApprovedToSeller(
  sellerEmail: string,
  data: {
    sellerName: string;
    itemTitle: string;
    buyerName: string;
    orderNumber: string;
  }
): Promise<void> {
  const html = loadTemplate('insurance-claim-approved-seller', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: sellerEmail,
    subject: `📦 Lost Item Claim Resolved - ${data.itemTitle}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send claim approved email to seller:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Claim approved email sent to seller: ${sellerEmail}`);
}

export async function sendInsuranceClaimDeniedToBuyer(
  buyerEmail: string,
  data: {
    buyerName: string;
    itemTitle: string;
    reason: string;
    orderNumber: string;
  }
): Promise<void> {
  const html = loadTemplate('insurance-claim-denied-buyer', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: buyerEmail,
    subject: `Lost Item Claim Update - ${data.itemTitle}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send claim denied email to buyer:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Claim denied email sent to buyer: ${buyerEmail}`);
}

export async function sendInsuranceClaimDeniedToSeller(
  sellerEmail: string,
  data: {
    sellerName: string;
    itemTitle: string;
    orderNumber: string;
  }
): Promise<void> {
  const html = loadTemplate('insurance-claim-denied-seller', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: sellerEmail,
    subject: `✅ Lost Item Claim Resolved - ${data.itemTitle}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send claim denied email to seller:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Claim denied email sent to seller: ${sellerEmail}`);
}

// ============================================
// INSURANCE REPORT EMAILS
// ============================================

export async function sendInsuranceReportReceivedToBuyer(
  buyerEmail: string,
  data: {
    buyerName: string;
    itemTitle: string;
    orderNumber: string;
    sellerName: string;
  }
): Promise<void> {
  const html = loadTemplate('insurance-report-received-buyer', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: buyerEmail,
    subject: `📦 Lost Item Report Received - ${data.itemTitle}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send report received email to buyer:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Report received email sent to buyer: ${buyerEmail}`);
}

export async function sendInsuranceReportReceivedToSeller(
  sellerEmail: string,
  data: {
    sellerName: string;
    itemTitle: string;
    orderNumber: string;
    buyerName: string;
  }
): Promise<void> {
  const html = loadTemplate('insurance-report-received-seller', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: sellerEmail,
    subject: `📦 Item Reported Lost - ${data.itemTitle}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send report received email to seller:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Report received email sent to seller: ${sellerEmail}`);
}

// ============================================
// ACCOUNT DELETION EMAILS
// ============================================
// Add these functions to src/services/emailService.ts

export async function sendDeletionRequested(
  userEmail: string,
  data: {
    userName: string;
    deletionDate: string;
    listingsSuspended: number;
  }
): Promise<void> {
  const html = loadTemplate('deletion-requested', {
    userName: data.userName,
    deletionDate: data.deletionDate,
    listingsSuspended: String(data.listingsSuspended),
  });

  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: userEmail,
    subject: 'Account Deletion Requested - Mulligans',
    html: html,
  });

  if (error) {
    console.error('[ACCOUNT-DELETION] Failed to send deletion requested email:', error);
    throw new Error(error.message);
  }

  console.log(`[ACCOUNT-DELETION] Deletion requested email sent to ${userEmail}`);
}

export async function sendDeletionCancelled(
  userEmail: string,
  data: {
    userName: string;
    listingsReactivated: number;
  }
): Promise<void> {
  const html = loadTemplate('deletion-cancelled', {
    userName: data.userName,
    listingsReactivated: String(data.listingsReactivated),
  });

  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: userEmail,
    subject: 'Account Deletion Cancelled - Mulligans',
    html: html,
  });

  if (error) {
    console.error('[ACCOUNT-DELETION] Failed to send deletion cancelled email:', error);
    throw new Error(error.message);
  }

  console.log(`[ACCOUNT-DELETION] Deletion cancelled email sent to ${userEmail}`);
}

export async function sendDeletionAdminNotification(
  data: {
    userId: string;
    userEmail: string;
    userName: string;
    deletionDate: string;
    listingsSuspended: number;
  }
): Promise<void> {
  const html = loadTemplate('deletion-admin-notification', {
    userId: data.userId,
    userEmail: data.userEmail,
    userName: data.userName,
    deletionDate: data.deletionDate,
    listingsSuspended: String(data.listingsSuspended),
  });

  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: ADMIN_EMAIL,
    subject: 'Account Deletion Request - Admin Notification',
    html: html,
  });

  if (error) {
    console.error('[ACCOUNT-DELETION] Failed to send admin notification:', error);
    throw new Error(error.message);
  }

  console.log(`[ACCOUNT-DELETION] Admin notification sent for user ${data.userId}`);
}
