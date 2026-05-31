// ==========================================
// OFFER SYSTEM CHANGES (5 Feb 2026)
// ==========================================
// - Line 34: Added import for offerRoutes
// - Line 35: Added import for listingOfferRoutes
// - Line 36: Added import for runOfferJobs
// - Line 128-129: Added offer routes registration
// - Line 130: Added listing offer routes (mounted on /api/listing-offers)
// - Line 165-175: Added offer jobs cron (every 5 minutes)
// - Line 176-182: Added offer warning cron (every 15 minutes)
// - Line 198-204: Added offer jobs to startup run
// ==========================================
//
// CHANGELOG (Offer System Fixes — 2026-02-06):
// [Issue #34] Changed listingOfferRoutes mount from '/api/listings' to '/api/listing-offers'
//             to avoid route conflicts with the main listing routes.

// src/index.ts
import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import path from 'path';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';
import authRoutes from './routes/authRoutes';
import listingRoutes from './routes/listingRoutes';
import searchRoutes from './routes/searchRoutes';
import messageRoutes from './routes/messageRoutes';
import notificationRoutes from './routes/notificationRoutes';
import { SocketService } from './services/socketService';
import userRoutes from './routes/userRoutes';
import favoriteRoutes from './routes/favoriteRoutes';
import feedbackRoutes from './routes/feedbackRoutes';
import supportRoutes from './routes/supportRoutes';
import orderRoutes from './routes/orderRoutes';
import stripeRoutes from './routes/stripeRoutes';
import reviewRoutes from './routes/reviewRoutes';
import stripeConnectRoutes from './routes/stripeConnectRoutes';
import cartRoutes from './routes/cartRoutes';
import shippingRoutes from './routes/shippingRoutes';
import sesRoutes from './routes/sesRoutes';
import { runEscrowJobs } from './services/escrowService';
import { updateVerificationStatus } from './services/verificationService';
import disputeRoutes from './routes/disputeRoutes';
import adminRoutes from './routes/adminRoutes';
import emailActionRoutes from './routes/emailActionRoutes';
import connectRedirectRoutes from './routes/connectRedirectRoutes';
import returnRoutes from './routes/returnRoutes';
// OFFER SYSTEM IMPORTS
import offerRoutes from './routes/offerRoutes';
import listingOfferRoutes from './routes/listingOfferRoutes';
import chipRoutes from './routes/chipRoutes';
import fittingRoutes from './routes/fittingRoutes';
import { runOfferJobs, sendExpiryWarnings } from './jobs/offerJobs';
import { processAccountDeletions } from './jobs/accountDeletionJob';


const app = express();
const httpServer = createServer(app);
const PORT = Number(process.env.PORT) || 3001;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.set('trust proxy', 1);

// Serve static files (admin panel)
app.use(express.static('public'));

// Initialize WebSocket
const socketService = new SocketService(httpServer);

// Make socket service available to routes
app.set('socketService', socketService);

// Security: Add protective HTTP headers
// Admin pages need relaxed CSP (inline scripts) but still get all other protections
app.use((req, res, next) => {
  if (req.path.startsWith('/admin')) {
    helmet({
      contentSecurityPolicy: false,  // Admin pages use inline scripts
    })(req, res, next);
  } else {
    helmet()(req, res, next);
  }
});

// Rate limiting - general API (250 requests per 15 minutes per IP)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limiting for auth routes (10 attempts per 15 minutes per IP)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply general rate limiting to all routes
app.use(generalLimiter);

// CORS configuration
app.use(cors({
  origin: (origin, callback) => {
    // Mobile apps and server-to-server requests have no Origin header — always allow
    if (!origin) return callback(null, true);
    // If FRONTEND_URL is set, check against it (supports comma-separated list)
    const allowed = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : [];
    if (allowed.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// IMPORTANT: Stripe webhook needs raw body, so exclude it from JSON parsing
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

app.use(express.urlencoded({ extended: true }));

// Test routes disabled in production — re-enable locally by setting NODE_ENV=development
if (process.env.NODE_ENV === 'development') {
  console.log('⚠️ Test routes enabled (development mode)');
}

// Routes - auth has stricter rate limiting
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/listings', listingRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/users', userRoutes);
app.use('/api/favorites', favoriteRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/stripe/connect', stripeConnectRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/shipping', shippingRoutes);
app.use('/api/ses', sesRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/admin', adminRoutes);
app.use('/connect', connectRedirectRoutes);
// Payment redirect pages — branded screens that deep-link back to the app
app.get('/payment-success', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/payment-success.html'));
});
app.get('/payment-cancelled', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/payment-cancelled.html'));
});
app.use('/api/returns', returnRoutes);
// OFFER SYSTEM ROUTES
app.use('/api/offers', offerRoutes);
// [Issue #34] Changed from '/api/listings' to '/api/listing-offers' to avoid route conflicts
app.use('/api/listing-offers', listingOfferRoutes);
// CHIP AI CADDY ROUTES
app.use('/api/chip', chipRoutes);
app.use('/api/fitting', fittingRoutes);
app.use('/api/email-actions', emailActionRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);

  if (err.message === 'Only image files are allowed') {
    res.status(400).json({ error: err.message });
    return;
  }

  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ============================================
// ESCROW CRON JOB
// Runs daily at 2:00 AM UK time to:
// - Auto-cancel orders not shipped within 5 days
// - Auto-release escrow 3 days after delivery
// - Check for lost-in-transit items (14+ days)
// ============================================
cron.schedule('0 2 * * *', async () => {
  console.log('🕐 Starting daily jobs...');
  console.log(`📅 ${new Date().toISOString()}`);

  try {
    await runEscrowJobs();
    console.log('✅ Escrow jobs completed');
  } catch (error) {
    console.error('❌ Escrow jobs failed:', error);
  }

  try {
    await updateVerificationStatus();
    console.log('✅ Verification check completed');
  } catch (error) {
    console.error('❌ Verification check failed:', error);
  }
}, {
  timezone: 'Europe/London'
});

// ============================================
// OFFER SYSTEM CRON JOBS
// ============================================

// Run offer expiry/void jobs every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  try {
    await runOfferJobs();
  } catch (error) {
    console.error('❌ Offer jobs failed:', error);
  }
}, {
  timezone: 'Europe/London'
});

// Send 2-hour expiry warnings every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  try {
    await sendExpiryWarnings();
  } catch (error) {
    console.error('❌ Offer warning jobs failed:', error);
  }
}, {
  timezone: 'Europe/London'
});

// ============================================
// ACCOUNT DELETION CRON JOB
// Runs daily at 3:00 AM UK time (after escrow at 2:00 AM)
// Processes accounts past their 30-day deletion deadline
// ============================================
cron.schedule('0 3 * * *', async () => {
  console.log('[ACCOUNT-DELETION] Starting scheduled account deletion processing...');
  try {
    await processAccountDeletions();
    console.log('[ACCOUNT-DELETION] Scheduled processing completed');
  } catch (error) {
    console.error('[ACCOUNT-DELETION] Scheduled processing failed:', error);
  }
}, {
  timezone: 'Europe/London'
});

// Also run escrow jobs on server startup (after 30 seconds delay)
// This catches any missed jobs if server was down
setTimeout(async () => {
  console.log('🔄 Running escrow jobs on startup...');
  try {
    await runEscrowJobs();
    console.log('✅ Startup escrow jobs completed');
  } catch (error) {
    console.error('❌ Startup escrow jobs failed:', error);
  }

  // OFFER SYSTEM: Also run offer jobs on startup
  console.log('🔄 Running offer jobs on startup...');
  try {
    await runOfferJobs();
    console.log('✅ Startup offer jobs completed');
  } catch (error) {
    console.error('❌ Startup offer jobs failed:', error);
  }
}, 30000);

// Account deletion startup check (60 second delay)
setTimeout(async () => {
  console.log('[ACCOUNT-DELETION] Running account deletion check on startup...');
  try {
    await processAccountDeletions();
    console.log('[ACCOUNT-DELETION] Startup processing completed');
  } catch (error) {
    console.error('[ACCOUNT-DELETION] Startup processing failed:', error);
  }
}, 60000);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════');
  console.log(`🚀 Server running on ${BASE_URL}`);
  console.log('═══════════════════════════════════════════');
  console.log(`🏥 Health check: ${BASE_URL}/health`);
  console.log(`🔐 Auth API: ${BASE_URL}/api/auth`);
  console.log(`📦 Listings API: ${BASE_URL}/api/listings`);
  console.log(`🔍 Search API: ${BASE_URL}/api/search`);
  console.log(`💬 Messages API: ${BASE_URL}/api/messages`);
  console.log(`👤 Users API: ${BASE_URL}/api/users`);
  console.log(`❤️ Favorites API: ${BASE_URL}/api/favorites`);
  console.log(`🔔 Notifications API: ${BASE_URL}/api/notifications`);
  console.log(`📝 Orders API: ${BASE_URL}/api/orders`);
  console.log(`💳 Stripe API: ${BASE_URL}/api/stripe`);
  console.log(`⭐ Reviews API: ${BASE_URL}/api/reviews`);
  console.log(`🛒 Cart API: ${BASE_URL}/api/cart`);
  console.log(`📮 Shipping API: ${BASE_URL}/api/shipping`);
  console.log(`🤝 Offers API: ${BASE_URL}/api/offers`);
  console.log(`🏷️ Listing Offers API: ${BASE_URL}/api/listing-offers`);
  console.log('═══════════════════════════════════════════');
  console.log('🌐 WebSocket: Enabled');
  console.log('🔒 Security: Helmet + Rate Limiting enabled');
  console.log('⏰ Escrow cron job: Daily at 2:00 AM UK time');
  console.log('⏰ Offer cron jobs: Every 5 min (expiry) + 15 min (warnings)');
  console.log('═══════════════════════════════════════════');
});
