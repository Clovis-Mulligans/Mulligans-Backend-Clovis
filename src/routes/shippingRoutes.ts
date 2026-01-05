// src/routes/shippingRoutes.ts
// Routes for shipping functionality (Shippo integration)

import express from 'express';
import {
  getParcelSizes,
  getShippingRates,
  createShippingLabel,
  getTrackingInfo,
  markAsShipped,
  handleShippoWebhook,
} from '../controllers/shippingController';
import { authenticateToken } from '../middleware/auth';

const router = express.Router();

// ============================================
// TYPE DEFINITIONS
// ============================================

interface ShippoAddress {
  object_id?: string;
  test?: boolean;
  name?: string;
  company?: string;
  street1?: string;
  street2?: string;
  city?: string;
  zip?: string;
  country?: string;
  phone?: string;
}

interface ShippoLocation {
  object_id: string;
  provider?: string;
  address?: ShippoAddress;
  distance_amount?: number;
  distance_unit?: string;
  opening_hours?: any;
}

interface ShippoLocationsResponse {
  results?: ShippoLocation[];
}

// ============================================
// PUBLIC ROUTES
// ============================================

// Get available parcel sizes with default prices
// GET /api/shipping/parcel-sizes
router.get('/parcel-sizes', getParcelSizes);

// Shippo webhook (no auth - called by Shippo)
// POST /api/shipping/webhook
router.post('/webhook', handleShippoWebhook);

// ============================================
// AUTHENTICATED ROUTES
// ============================================

// Get shipping rates for an order (seller only)
// POST /api/shipping/rates
router.post('/rates', authenticateToken, getShippingRates);

// Create shipping label (seller only)
// POST /api/shipping/labels
router.post('/labels', authenticateToken, createShippingLabel);

// Get tracking info for an order (buyer or seller)
// GET /api/shipping/tracking/:orderId
router.get('/tracking/:orderId', authenticateToken, getTrackingInfo);

// Mark order as shipped (seller only)
// POST /api/shipping/mark-shipped
router.post('/mark-shipped', authenticateToken, markAsShipped);

// ============================================
// DROP-OFF LOCATIONS (Shippo Locations API)
// ============================================

// Get drop-off locations near a postcode
// GET /api/shipping/dropoff-locations?postcode=SW1A1AA&carrier=evri
router.get('/dropoff-locations', authenticateToken, async (req: any, res) => {
  try {
    const { postcode, carrier } = req.query;
    
    if (!postcode) {
      return res.status(400).json({ error: 'Postcode is required' });
    }

    console.log(`📍 Fetching drop-off locations for postcode: ${postcode}, carrier: ${carrier || 'all'}`);

    // Step 1: Create address object in Shippo
    const addressResponse = await fetch('https://api.goshippo.com/addresses/', {
      method: 'POST',
      headers: {
        'Authorization': `ShippoToken ${process.env.SHIPPO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        country: 'GB',
        zip: String(postcode).replace(/\s/g, ''), // Remove spaces from postcode
      }),
    });

    const addressData = await addressResponse.json() as ShippoAddress;
    
    console.log('📍 Shippo address response:', JSON.stringify(addressData, null, 2));
    
    if (!addressData.object_id) {
      return res.status(400).json({ 
        error: 'Failed to create address', 
        details: addressData 
      });
    }

    // Step 2: Get locations for this address
    const locationsResponse = await fetch(
      `https://api.goshippo.com/addresses/${addressData.object_id}/locations/sync`,
      {
        headers: {
          'Authorization': `ShippoToken ${process.env.SHIPPO_API_KEY}`,
        },
      }
    );

    const locationsData = await locationsResponse.json() as ShippoLocationsResponse;
    
    console.log('📍 Shippo locations response:', JSON.stringify(locationsData, null, 2));

    // Filter by carrier if specified
    let locations = locationsData.results || [];
    if (carrier && locations.length > 0) {
      locations = locations.filter((loc: ShippoLocation) => 
        loc.provider?.toLowerCase().includes(String(carrier).toLowerCase())
      );
    }

    res.json({
      postcode,
      count: locations.length,
      locations: locations.map((loc: ShippoLocation) => ({
        id: loc.object_id,
        name: loc.address?.name || loc.address?.company || 'Drop-off Point',
        provider: loc.provider,
        address: {
          street1: loc.address?.street1,
          street2: loc.address?.street2,
          city: loc.address?.city,
          postcode: loc.address?.zip,
          country: loc.address?.country,
        },
        distance: loc.distance_amount ? `${loc.distance_amount} ${loc.distance_unit}` : null,
        phone: loc.address?.phone,
        openingHours: loc.opening_hours || null,
      })),
      // Include debug info to help diagnose issues
      _debug: {
        addressObjectId: addressData.object_id,
        rawLocationsCount: locationsData.results?.length || 0,
        isTestMode: addressData.test || false,
      }
    });

  } catch (error) {
    console.error('❌ Drop-off locations error:', error);
    res.status(500).json({ error: 'Failed to fetch drop-off locations' });
  }
});

export default router;