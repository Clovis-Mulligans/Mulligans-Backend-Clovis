import { prisma } from './prisma';

export interface SendingAddress {
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  postal_code: string;
  country: string;
}

export type SellerAddressResult = {
  address: SendingAddress | null;
  isReal: boolean;
  failureReason?: 'no_sending_address';
};

export async function getSellerSendingAddress(sellerId: string): Promise<SellerAddressResult> {
  const seller = await prisma.users.findUnique({
    where: { id: sellerId },
    select: { sending_address: true, display_name: true },
  });

  if (!seller) {
    return { address: null, isReal: false, failureReason: 'no_sending_address' };
  }

  const addr = seller.sending_address as SendingAddress | null;

  if (!addr || !addr.line1 || !addr.postal_code || !addr.city || !addr.country) {
    return { address: null, isReal: false, failureReason: 'no_sending_address' };
  }

  return {
    address: {
      name: addr.name || seller.display_name || 'Seller',
      line1: addr.line1,
      line2: addr.line2 || null,
      city: addr.city,
      postal_code: addr.postal_code,
      country: addr.country,
    },
    isReal: true,
  };
}

export function validateSendingAddress(data: any): { valid: boolean; error?: string } {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Address must be an object' };
  }
  if (!data.line1 || typeof data.line1 !== 'string' || data.line1.trim().length === 0) {
    return { valid: false, error: 'line1 (street address) is required' };
  }
  if (!data.city || typeof data.city !== 'string' || data.city.trim().length === 0) {
    return { valid: false, error: 'city is required' };
  }
  if (!data.postal_code || typeof data.postal_code !== 'string' || data.postal_code.trim().length === 0) {
    return { valid: false, error: 'postal_code is required' };
  }
  if (!data.country || typeof data.country !== 'string' || data.country.trim().length < 2) {
    return { valid: false, error: 'country is required (ISO 2-letter code)' };
  }
  if (data.line1.length > 200 || data.city.length > 100 || data.postal_code.length > 20) {
    return { valid: false, error: 'Address field exceeds maximum length' };
  }
  return { valid: true };
}
