import { Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma';
import { createListingSchema } from '../middleware/validation';
import { IncomingListing } from './csvAdapter';
import { sellerIsPayoutReady } from '../lib/payoutReadiness';
import { validateListingCompleteness } from '../lib/listingCompleteness';
import { expireOffersForSoldItem } from '../jobs/offerJobs';

const ACTIVE_ORDER_STATUSES = ['pending', 'paid', 'to_ship', 'shipped', 'in_transit', 'delivered'];

export interface ImportResult {
  created: Array<{ id: string; title: string; external_id: string }>;
  updated: Array<{ id: string; title: string; external_id: string; changed_fields: string[]; reactivated?: boolean }>;
  skipped: Array<{ row: number; external_id: string; reason: string }>;
  failed: Array<{ row: number; reason: string }>;
  warnings: string[];
}

function fieldChanged(field: string, csvVal: any, dbVal: any): boolean {
  if (csvVal == null && dbVal == null) return false;
  if (csvVal == null || dbVal == null) return true;
  if (field === 'price' || field === 'shipping_cost') {
    return parseFloat(String(csvVal)) !== parseFloat(String(dbVal));
  }
  return String(csvVal) !== String(dbVal);
}

export async function importListings(
  rows: IncomingListing[],
  sellerId: string,
  adapterFailures: Array<{ row: number; reason: string }>,
  adapterWarnings: string[],
): Promise<ImportResult> {
  const created: ImportResult['created'] = [];
  const updated: ImportResult['updated'] = [];
  const skipped: ImportResult['skipped'] = [];
  const failed: ImportResult['failed'] = [...adapterFailures];
  const warnings: string[] = [...adapterWarnings];

  let payoutReady: boolean | null = null;
  async function checkPayoutReady(): Promise<boolean> {
    if (payoutReady === null) {
      const check = await sellerIsPayoutReady(sellerId);
      payoutReady = check.ready;
    }
    return payoutReady;
  }

  const now = new Date();

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

      const existing = await prisma.listings.findFirst({
        where: {
          seller_id: sellerId,
          external_source: 'csv',
          external_id: row.external_id,
        },
        include: { images: { select: { id: true } } },
      });

      if (existing) {
        // ── UPDATE PATH ──

        if (existing.status === 'removed') {
          skipped.push({ row: rowNum, external_id: row.external_id, reason: 'removed' });
          continue;
        }

        const activeOrder = await prisma.orders.findFirst({
          where: {
            listing_id: existing.id,
            status: { in: ACTIVE_ORDER_STATUSES },
          },
          select: { id: true, status: true },
        });

        if (activeOrder) {
          skipped.push({ row: rowNum, external_id: row.external_id, reason: 'active_order' });
          continue;
        }

        const csvQty = validData.quantity ?? 1;
        const unitsConsumed = existing.qty_at_last_import != null
          ? existing.qty_at_last_import - existing.quantity
          : 0;
        const newQuantity = Math.max(0, csvQty - unitsConsumed);

        const changedFields: string[] = [];
        const rowWarnings: string[] = [];

        const syncFields: Array<{ field: string; csv: any; db: any }> = [
          { field: 'title', csv: validData.title, db: existing.title },
          { field: 'description', csv: validData.description, db: existing.description },
          { field: 'price', csv: validData.price, db: existing.price },
          { field: 'category', csv: validData.category, db: existing.category },
          { field: 'subcategory', csv: validData.subcategory || null, db: existing.subcategory },
          { field: 'brand', csv: validData.brand || null, db: existing.brand },
          { field: 'model', csv: validData.model || null, db: existing.model },
          { field: 'condition_overall', csv: validData.condition_overall || null, db: existing.condition_overall },
          { field: 'location', csv: validData.location || 'UK', db: existing.location },
          { field: 'is_negotiable', csv: validData.is_negotiable || false, db: existing.is_negotiable },
          { field: 'parcel_size', csv: validData.parcel_size || null, db: existing.parcel_size },
          { field: 'shipping_cost', csv: validData.shipping_cost ?? null, db: existing.shipping_cost },
        ];

        const updateData: Record<string, any> = {
          updated_at: now,
          last_imported_at: now,
          qty_at_last_import: csvQty,
        };

        for (const { field, csv, db } of syncFields) {
          if (fieldChanged(field, csv, db)) {
            changedFields.push(field);
            if (field === 'price') {
              rowWarnings.push(`price changed: ${db} → ${csv}`);
            }
          }
          updateData[field] = csv;
        }

        if (newQuantity !== existing.quantity) {
          changedFields.push('quantity');
        }
        updateData.quantity = newQuantity;

        updateData.specifications = validData.specifications ?? Prisma.JsonNull;

        let newStatus = existing.status;
        let reactivated = false;

        if (existing.status === 'draft') {
          // stays draft
        } else if (existing.status === 'active') {
          if (newQuantity === 0) {
            newStatus = 'off_sale';
            await expireOffersForSoldItem(existing.id);
            await prisma.cart_items.deleteMany({ where: { listing_id: existing.id } });
          }
        } else if (existing.status === 'off_sale' || existing.status === 'sold') {
          if (newQuantity >= 1) {
            const canReactivate = await checkPayoutReady();
            const imageCount = existing.images?.length ?? 0;
            const mergedForValidation = { ...existing, ...updateData, quantity: newQuantity };
            const completenessError = canReactivate
              ? validateListingCompleteness(mergedForValidation, imageCount)
              : null;

            if (canReactivate && !completenessError) {
              newStatus = 'active';
              reactivated = true;
            } else {
              const reason = !canReactivate ? 'payout_not_ready' : completenessError!;
              rowWarnings.push(`restock_blocked: ${reason}`);
            }
          }
        } else if (existing.status === 'deleted') {
          reactivated = true;
          if (newQuantity >= 1) {
            const canReactivate = await checkPayoutReady();
            const imageCount = existing.images?.length ?? 0;
            const mergedForValidation = { ...existing, ...updateData, quantity: newQuantity };
            const completenessError = canReactivate
              ? validateListingCompleteness(mergedForValidation, imageCount)
              : null;

            if (canReactivate && !completenessError) {
              newStatus = 'active';
            } else {
              newStatus = 'draft';
            }
          } else {
            newStatus = 'draft';
          }
        }

        if (newStatus !== existing.status) {
          changedFields.push('status');
        }
        updateData.status = newStatus;

        await prisma.listings.update({
          where: { id: existing.id },
          data: updateData,
        });

        if (validData.specifications && typeof validData.specifications === 'object') {
          await prisma.listing_attributes.deleteMany({ where: { listing_id: existing.id } });

          const attributeRecords: any[] = [];
          Object.entries(validData.specifications).forEach(([key, value]) => {
            if (key === 'setMakeup' && Array.isArray(value)) {
              value.forEach((iron: string) => {
                attributeRecords.push({
                  id: uuidv4(),
                  listing_id: existing.id,
                  key: 'setMakeup',
                  value: iron,
                  created_at: now,
                });
              });
            } else {
              attributeRecords.push({
                id: uuidv4(),
                listing_id: existing.id,
                key,
                value: typeof value === 'string' ? value : JSON.stringify(value),
                created_at: now,
              });
            }
          });
          if (attributeRecords.length > 0) {
            await prisma.listing_attributes.createMany({ data: attributeRecords });
          }
        }

        for (const w of rowWarnings) {
          warnings.push(`Row ${rowNum} (${row.external_id}): ${w}`);
        }

        updated.push({
          id: existing.id,
          title: validData.title,
          external_id: row.external_id,
          changed_fields: changedFields,
          ...(reactivated ? { reactivated: true } : {}),
        });
      } else {
        // ── CREATE PATH ──

        const listingId = uuidv4();

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
            qty_at_last_import: validData.quantity ?? 1,
            last_imported_at: now,
            created_at: now,
            updated_at: now,
          },
        });

        if (validData.specifications && typeof validData.specifications === 'object') {
          const attributeRecords: any[] = [];
          Object.entries(validData.specifications).forEach(([key, value]) => {
            if (key === 'setMakeup' && Array.isArray(value)) {
              value.forEach((iron: string) => {
                attributeRecords.push({
                  id: uuidv4(),
                  listing_id: listing.id,
                  key: 'setMakeup',
                  value: iron,
                  created_at: now,
                });
              });
            } else {
              attributeRecords.push({
                id: uuidv4(),
                listing_id: listing.id,
                key,
                value: typeof value === 'string' ? value : JSON.stringify(value),
                created_at: now,
              });
            }
          });
          if (attributeRecords.length > 0) {
            await prisma.listing_attributes.createMany({ data: attributeRecords });
          }
        }

        created.push({ id: listing.id, title: listing.title, external_id: row.external_id });
      }
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const target = err.meta?.target;
        if (Array.isArray(target) && target.includes('listings_external_dedup')) {
          failed.push({ row: rowNum, reason: 'duplicate' });
        } else {
          failed.push({ row: rowNum, reason: `id collision (constraint: ${target}) — retry` });
        }
      } else {
        failed.push({ row: rowNum, reason: err.message || 'unexpected error' });
      }
    }
  }

  return { created, updated, skipped, failed, warnings };
}
