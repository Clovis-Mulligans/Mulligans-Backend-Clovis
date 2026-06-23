import { parse } from 'csv-parse/sync';
import crypto from 'crypto';

export interface IncomingListing {
  _rowNum: number;
  title: string;
  description: string;
  price: number;
  category: string;
  subcategory: string;
  location: string;
  brand?: string | null;
  model?: string | null;
  is_negotiable?: boolean;
  parcel_size: string;
  shipping_cost: number;
  quantity?: number;
  condition_overall?: number;
  specifications?: Record<string, any>;
  status: 'draft';
  external_source: 'csv';
  external_id: string;
}

export interface AdapterResult {
  rows: IncomingListing[];
  failed: Array<{ row: number; reason: string }>;
  warnings: string[];
}

const VALID_CATEGORIES = [
  'Clubs',
  'Shafts, Grips & Heads',
  'Clothing',
  'Shoes',
  'Accessories',
  'Balls',
  'Training Aids',
  'Everything Else',
] as const;

const CATEGORY_ALIASES: Record<string, string> = {
  'shafts grips & heads': 'Shafts, Grips & Heads',
  'shafts, grips & heads': 'Shafts, Grips & Heads',
  'training aids': 'Training Aids',
  'everything else': 'Everything Else',
  'clubs': 'Clubs',
  'clothing': 'Clothing',
  'shoes': 'Shoes',
  'accessories': 'Accessories',
  'balls': 'Balls',
};

const CONDITION_MAP: Record<string, number> = {
  'new': 5,
  'like new': 4,
  'very good': 3,
  'good': 2,
  'fair': 1,
};

const PARCEL_SIZE_MAP: Record<string, string> = {
  'small': 'small',
  'medium': 'medium',
  'large': 'large',
  'extra large': 'extra_large',
  'extra_large': 'extra_large',
  'oversized': 'oversized',
};

const SPEC_FIELDS = [
  'club_type', 'shaft_flex', 'shaft_material', 'loft', 'lie_angle',
  'shaft_length', 'dexterity', 'size', 'gender', 'colour',
];

function normalizeCategory(raw: string): string | null {
  const lower = raw.trim().toLowerCase();
  if (CATEGORY_ALIASES[lower]) return CATEGORY_ALIASES[lower];
  const exact = VALID_CATEGORIES.find(c => c.toLowerCase() === lower);
  return exact ?? null;
}

function normalizeParcelSize(raw: string): string | null {
  return PARCEL_SIZE_MAP[raw.trim().toLowerCase()] ?? null;
}

function normalizeCondition(raw: string): number | null {
  return CONDITION_MAP[raw.trim().toLowerCase()] ?? null;
}

function contentHash(title: string, brand: string, model: string, category: string, price: number): string {
  const input = [
    title.trim().toLowerCase(),
    (brand || '').trim().toLowerCase(),
    (model || '').trim().toLowerCase(),
    category.trim().toLowerCase(),
    String(price),
  ].join('|');
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function parseCsv(buffer: Buffer): AdapterResult {
  const records: Record<string, string>[] = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  const rows: IncomingListing[] = [];
  const failed: Array<{ row: number; reason: string }> = [];
  const warnings: string[] = [];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const rowNum = i + 1;

    try {
      const title = rec.title?.trim();
      if (!title) { failed.push({ row: rowNum, reason: 'missing title' }); continue; }

      const description = rec.description?.trim();
      if (!description) { failed.push({ row: rowNum, reason: 'missing description' }); continue; }

      const priceRaw = parseFloat(rec.price);
      if (isNaN(priceRaw) || priceRaw < 0.50 || priceRaw > 50000) {
        failed.push({ row: rowNum, reason: 'invalid price (must be 0.50–50000)' }); continue;
      }

      const categoryRaw = rec.category?.trim();
      if (!categoryRaw) { failed.push({ row: rowNum, reason: 'missing category' }); continue; }
      const category = normalizeCategory(categoryRaw);
      if (!category) { failed.push({ row: rowNum, reason: `unknown category: '${categoryRaw}'` }); continue; }

      const subcategory = rec.subcategory?.trim();
      if (!subcategory) { failed.push({ row: rowNum, reason: 'missing subcategory' }); continue; }

      const parcelSizeRaw = rec.parcel_size?.trim();
      if (!parcelSizeRaw) { failed.push({ row: rowNum, reason: 'missing parcel_size' }); continue; }
      const parcel_size = normalizeParcelSize(parcelSizeRaw);
      if (!parcel_size) { failed.push({ row: rowNum, reason: `invalid parcel_size: '${parcelSizeRaw}'` }); continue; }

      const shippingCostRaw = parseFloat(rec.shipping_cost);
      if (isNaN(shippingCostRaw) || shippingCostRaw < 0 || shippingCostRaw > 100) {
        failed.push({ row: rowNum, reason: 'invalid shipping_cost (must be 0–100)' }); continue;
      }

      const location = rec.location?.trim() || 'UK';

      const brand = rec.brand?.trim() || null;
      const model = rec.model?.trim() || null;

      const acceptsOffers = rec.accepts_offers?.trim().toLowerCase();
      const is_negotiable = acceptsOffers === 'true' || acceptsOffers === 'yes' || acceptsOffers === '1';

      const quantityRaw = rec.quantity?.trim();
      let quantity = 1;
      if (quantityRaw) {
        const q = parseInt(quantityRaw, 10);
        if (!isNaN(q) && q >= 1 && q <= 999) quantity = q;
        else { warnings.push(`Row ${rowNum}: invalid quantity '${quantityRaw}', defaulting to 1`); }
      }

      let condition_overall: number | undefined;
      const conditionRaw = rec.condition?.trim();
      if (conditionRaw) {
        const mapped = normalizeCondition(conditionRaw);
        if (mapped !== null) condition_overall = mapped;
        else warnings.push(`Row ${rowNum}: unknown condition '${conditionRaw}', skipping`);
      }

      const specifications: Record<string, any> = {};
      for (const field of SPEC_FIELDS) {
        const val = rec[field]?.trim();
        if (val) specifications[field] = val;
      }

      const sku = rec.sku?.trim();
      const external_id = sku || contentHash(title, brand || '', model || '', category, priceRaw);

      rows.push({
        _rowNum: rowNum,
        title,
        description,
        price: priceRaw,
        category,
        subcategory,
        location,
        brand,
        model,
        is_negotiable,
        parcel_size,
        shipping_cost: shippingCostRaw,
        quantity,
        condition_overall,
        specifications: Object.keys(specifications).length > 0 ? specifications : undefined,
        status: 'draft',
        external_source: 'csv',
        external_id,
      });
    } catch (err: any) {
      failed.push({ row: rowNum, reason: err.message || 'unexpected error' });
    }
  }

  return { rows, failed, warnings };
}
