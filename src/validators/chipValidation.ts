// src/middleware/chipValidation.ts
// Zod validation schemas for all Chip AI Caddy endpoints
//
// Follows existing pattern from src/middleware/validation.ts
// Use with: validate(schema) middleware

import { z } from 'zod';

// ============================================
// FITTING PROFILE SCHEMAS
// ============================================

export const createFittingProfileSchema = z.object({
  body: z.object({
    handicap: z.enum([
      'beginner',
      '36+',
      '21-36',
      '13-20',
      '6-12',
      '0-5',
      'scratch_or_better',
    ]).optional(),
    dexterity: z.enum(['right', 'left']).optional(),
    height_cm: z.number().int().min(100).max(250).optional(),
    looking_for: z.array(z.enum([
      'full_bag',
      'driver',
      'fairway_woods',
      'hybrids',
      'irons',
      'wedges',
      'putter',
      'balls',
      'bag_accessories',
      'educate_me',
      'just_browsing',
    ])).optional(),
    play_frequency: z.enum([
      'few_times_a_year',
      'once_a_month',
      '2_3_times_a_month',
      'weekly',
      'multiple_times_a_week',
    ]).optional(),
    goals: z.array(z.enum([
      'distance',
      'accuracy',
      'slice',
      'hook',
      'short_game',
      'putting',
      'consistency',
      'not_sure',
    ])).optional(),
    budget_range: z.enum([
      'under_50',
      '50_100',
      '100_200',
      '200_400',
      '400_700',
      '700_plus',
      'no_limit',
    ]).optional(),
    condition_pref: z.enum([
      'new_only',
      'excellent_or_better',
      'good_or_better',
      'any_condition',
    ]).optional(),
    brand_preferences: z.array(z.string().max(50)).max(15).optional(),
    glove_size: z.enum(['small', 'medium_large', 'large', 'xl', 'not_sure']).optional(),
  }),
});

export const updateFittingProfileSchema = createFittingProfileSchema;

// ============================================
// BAG MANAGEMENT SCHEMAS
// ============================================

const CLUB_TYPES = [
  'driver', '3_wood', '5_wood', '7_wood',
  '2_hybrid', '3_hybrid', '4_hybrid', '5_hybrid',
  '2_iron', '3_iron', '4_iron', '5_iron', '6_iron', '7_iron', '8_iron', '9_iron',
  'pw', 'gw', 'sw', 'lw',
  'putter',
] as const;

export const addBagClubSchema = z.object({
  body: z.object({
    club_type: z.enum(CLUB_TYPES),
    brand: z.string().max(50).optional(),
    model: z.string().max(100).optional(),
    shaft_flex: z.enum(['ladies', 'senior', 'regular', 'stiff', 'extra_stiff']).optional(),
    loft: z.number().min(0).max(80).optional(),
    notes: z.string().max(500).optional(),
  }),
});

export const updateBagClubSchema = z.object({
  body: z.object({
    club_type: z.enum(CLUB_TYPES).optional(),
    brand: z.string().max(50).optional(),
    model: z.string().max(100).optional(),
    shaft_flex: z.enum(['ladies', 'senior', 'regular', 'stiff', 'extra_stiff']).optional(),
    loft: z.number().min(0).max(80).optional(),
    notes: z.string().max(500).optional(),
  }),
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const deleteBagClubSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

// ============================================
// SWING DATA SCHEMAS
// ============================================

const SWING_SOURCES = ['trackman', 'toptracer', 'gcquad', 'mevo', 'skytrak', 'manual'] as const;

export const addSwingDataSchema = z.object({
  body: z.object({
    club_type: z.enum(CLUB_TYPES).optional(),
    club_speed_mph: z.number().min(0).max(200).optional(),
    ball_speed_mph: z.number().min(0).max(250).optional(),
    launch_angle_deg: z.number().min(-10).max(60).optional(),
    spin_rate_rpm: z.number().int().min(0).max(15000).optional(),
    carry_yards: z.number().int().min(0).max(400).optional(),
    smash_factor: z.number().min(0).max(2).optional(),
    source: z.enum(SWING_SOURCES),
  }),
});

export const deleteSwingDataSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

// ============================================
// CHAT SCHEMAS
// ============================================

export const createConversationSchema = z.object({
  body: z.object({
    listing_id: z.string().max(100).optional(),
  }),
});

export const sendMessageSchema = z.object({
  body: z.object({
    content: z.string().min(1).max(1000),
  }),
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const getConversationSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const deleteConversationSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

// ============================================
// RECOMMENDATIONS SCHEMA
// ============================================

export const getRecommendationsSchema = z.object({
  query: z.object({
    limit: z.string().regex(/^\d+$/).transform(Number).optional(),
    offset: z.string().regex(/^\d+$/).transform(Number).optional(),
  }),
});
