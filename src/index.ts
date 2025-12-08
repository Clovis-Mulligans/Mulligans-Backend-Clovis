// src/index.ts
import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
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

dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = Number(process.env.PORT) || 3001;  // ← FIXED: Convert to number

// Initialize WebSocket
const socketService = new SocketService(httpServer);

// Make socket service available to routes
app.set('socketService', socketService);

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
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

// Routes
app.use('/api/auth', authRoutes);
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

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
  console.log(`📱 Mobile access: http://192.168.1.233:${PORT}`);
  console.log(`📊 Health check: http://192.168.1.233:${PORT}/health`);
  console.log(`🔐 Auth API: http://192.168.1.233:${PORT}/api/auth`);
  console.log(`📦 Listings API: http://192.168.1.233:${PORT}/api/listings`);
  console.log(`🔍 Search API: http://192.168.1.233:${PORT}/api/search`);
  console.log(`💬 Messages API: http://192.168.1.233:${PORT}/api/messages`);
  console.log(`⚡ WebSocket: Enabled`);
});