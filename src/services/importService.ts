import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { createListingSchema } from '../middleware/validation';
import { IncomingListing } from './csvAdapter';

export interface ImportResult {
  created: Array<{ id: string; title: string; external_id: string }>;
  failed: Array<{ row: number; reason: string }>;
  warnings: string[];
}

export async function importListings(
  rows: IncomingListing[],
  sellerId: string,
  adapterFailures: Array<{ row: number; reason: string }>,
  adapterWarnings: string[],
): Promise<ImportResult> {
  const created: ImportResult['created'] = [];
  const failed: ImportResult['failed'] = [...adapterFailures];
  const warnings: string[] = [...adapterWarnings];

  for (const row of rows) {
    const rowNum = row._rowNum;

    try {
      const parsed = createListingSchema.safeParse({ body: row });
      if (!parsed.success) {
        const reasons = parsed.error.issues.map(
          iss => `${iss.path.slice(1).join('.')}: ${iss.message}`,
        ).join('; ');
        failed.push({ row: rowNum, reason: reasons });
        continue;
      }

      const validData = parsed.data.body;

      const listingId = `lst_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const listing = await prisma.listings.create({
        data: {
          id: listingId,
          title: validData.title,
          description: validData.description,
          price: validData.price,
          category: validData.category,
          subcategory: validData.subcategory || null,
          brand: validData.brand || null,
          model: validData.model || null,
          condition_overall: validData.condition_overall || null,
          condition_head: validData.condition_head || null,
          condition_shaft: validData.condition_shaft || null,
          condition_grip: validData.condition_grip || null,
          specifications: validData.specifications ?? Prisma.JsonNull,
          location: validData.location || 'UK',
          is_negotiable: validData.is_negotiable || false,
          parcel_size: validData.parcel_size || null,
          shipping_cost: validData.shipping_cost ?? null,
          quantity: validData.quantity ?? 1,
          seller_id: sellerId,
          status: 'draft',
          external_source: row.external_source,
          external_id: row.external_id,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });

      if (validData.specifications && typeof validData.specifications === 'object') {
        const attributeRecords: any[] = [];
        Object.entries(validData.specifications).forEach(([key, value]) => {
          if (key === 'setMakeup' && Array.isArray(value)) {
            value.forEach((iron: string) => {
              attributeRecords.push({
                id: `attr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                listing_id: listing.id,
                key: 'setMakeup',
                value: iron,
                created_at: new Date(),
              });
            });
          } else {
            attributeRecords.push({
              id: `attr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              listing_id: listing.id,
              key,
              value: typeof value === 'string' ? value : JSON.stringify(value),
              created_at: new Date(),
            });
          }
        });
        if (attributeRecords.length > 0) {
          await prisma.listing_attributes.createMany({ data: attributeRecords });
        }
      }

      created.push({ id: listing.id, title: listing.title, external_id: row.external_id });
    } catch (err: any) {
      if (err?.code === 'P2002' && err?.meta?.target?.includes('listings_external_dedup')) {
        failed.push({ row: rowNum, reason: 'duplicate' });
      } else {
        failed.push({ row: rowNum, reason: err.message || 'unexpected error' });
      }
    }
  }

  return { created, failed, warnings };
}
