// src/middleware/validation.ts
//
// CHANGELOG (Offer System Fixes — 2026-02-06):
// [Issue #33] Added createOfferSchema and counterOfferSchema for Zod validation
//             on the offer creation and counter-offer routes.

import { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';

/**
 * Generic validation middleware factory
 */
export const validate = (schema: z.ZodSchema) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      next();
   } catch (error) {
    if (error instanceof ZodError) {
        res.status(400).json({
    error: 'Validation failed',
    details: error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    })),
  });
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };
};

/**
 * Listing validation schemas
 */
export const createListingSchema = z.object({
  body: z.object({
    title: z.string().min(3).max(200),
    description: z.string().min(10).max(5000),
    price: z.number().min(0.50).max(50000),
    category: z.enum([
      'Clubs',
      'Shafts, Grips & Heads',
      'Clothing',
      'Shoes',
      'Accessories',
      'Balls',
      'Training Aids',
      'Everything Else'
    ]),
    subcategory: z.string().min(1).max(100),
    location: z.string().min(1).max(200),
    brand: z.string().max(100).optional().nullable(),
    model: z.string().max(100).optional().nullable(),
    is_negotiable: z.boolean().optional(),
    parcel_size: z.enum(['small', 'medium', 'large', 'extra_large','oversized']),
    shipping_cost: z.number().min(0).max(100),
    quantity: z.number().int().min(1).max(999).optional(),
    condition_overall: z.number().int().min(1).max(5).optional(),
    condition_head: z.number().int().min(1).max(5).optional(),
    condition_shaft: z.number().int().min(1).max(5).optional(),
    condition_grip: z.number().int().min(1).max(5).optional(),
    specifications: z.record(z.string(), z.any()).optional(),
    status: z.enum(['active', 'draft']).optional().default('active'),
  }),
});

export const updateListingSchema = z.object({
  body: z.object({
    title: z.string().min(3).max(200).optional(),
    description: z.string().min(10).max(5000).optional(),
    price: z.number().positive().optional(),
    category: z.enum([
      'Clubs',
      'Shafts, Grips & Heads',
      'Clothing',
      'Shoes',
      'Accessories',
      'Balls',
      'Training Aids',
      'Everything Else'
    ]).optional(),
    subcategory: z.string().min(1).max(100).optional(),
    location: z.string().min(1).max(200).optional(),
    brand: z.string().max(100).optional().nullable(),
    model: z.string().max(100).optional().nullable(),
    status: z.enum(['active', 'sold', 'reserved', 'removed', 'draft', 'off_sale']).optional(),
    is_negotiable: z.boolean().optional(),
    parcel_size: z.enum(['small', 'medium', 'large', 'extra_large','oversized']).optional(),
    shipping_cost: z.number().min(0).max(100).optional(),
    quantity: z.number().int().min(1).max(999).optional(),
    condition_overall: z.number().int().min(1).max(5).optional(),
    condition_head: z.number().int().min(1).max(5).optional(),
    condition_shaft: z.number().int().min(1).max(5).optional(),
    condition_grip: z.number().int().min(1).max(5).optional(),
    specifications: z.record(z.string(), z.any()).optional(),
  }),
  params: z.object({
    id: z.string(),
  }),
});

export const getListingsSchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).transform(Number).optional(),
    limit: z.string().regex(/^\d+$/).transform(Number).optional(),
    category: z.string().optional(),
    minPrice: z.string().regex(/^\d+(\.\d+)?$/).transform(Number).optional(),
    maxPrice: z.string().regex(/^\d+(\.\d+)?$/).transform(Number).optional(),
    condition: z.string().optional(),
    search: z.string().optional(),
    location: z.string().optional(),
    status: z.string().optional(),
  }),
});

// ============================================
// [Issue #33] OFFER VALIDATION SCHEMAS
// ============================================

/**
 * Schema for POST /api/offers (create a new offer)
 */
export const createOfferSchema = z.object({
  body: z.object({
    listing_id: z.string().min(1, 'listing_id is required'),
    offer_amount: z.number().positive('offer_amount must be a positive number'),
  }),
});

/**
 * Schema for PUT /api/offers/:id/counter (send a counter offer)
 */
export const counterOfferSchema = z.object({
  body: z.object({
    counter_amount: z.number().positive('counter_amount must be a positive number'),
  }),
});
