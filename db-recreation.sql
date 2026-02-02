-- ============================================
-- MULLIGANS DATABASE RECREATION SCRIPT
-- Created: 2026-02-02
-- Purpose: Recreate database schema in correct dependency order
-- WARNING: This script will DROP all existing data!
-- ============================================

-- Run this to recreate the database from scratch
-- Order is critical: tables with no foreign keys first, then dependent tables

-- ============================================
-- STEP 0: DROP ALL TABLES (in reverse dependency order)
-- ============================================

-- Drop tables that depend on others first
DROP TABLE IF EXISTS dispute_images CASCADE;
DROP TABLE IF EXISTS return_requests CASCADE;
DROP TABLE IF EXISTS disputes CASCADE;
DROP TABLE IF EXISTS support_ticket_images CASCADE;
DROP TABLE IF EXISTS support_tickets CASCADE;
DROP TABLE IF EXISTS blocked_users CASCADE;
DROP TABLE IF EXISTS user_reports CASCADE;
DROP TABLE IF EXISTS email_suppressions CASCADE;
DROP TABLE IF EXISTS cart_items CASCADE;
DROP TABLE IF EXISTS reviews CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS listing_attributes CASCADE;
DROP TABLE IF EXISTS images CASCADE;
DROP TABLE IF EXISTS favorites CASCADE;
DROP TABLE IF EXISTS listings CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS golf_models CASCADE;
DROP TABLE IF EXISTS golf_brands CASCADE;
DROP TABLE IF EXISTS shaft_specifications CASCADE;
DROP TABLE IF EXISTS push_tokens CASCADE;

-- ============================================
-- STEP 1: BASE TABLES (no foreign keys)
-- ============================================

-- Users table (base table - no dependencies)
CREATE TABLE users (
    id VARCHAR(255) PRIMARY KEY,
    cognito_id VARCHAR(255) UNIQUE,
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(255) UNIQUE,
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    profile_image VARCHAR(500),
    bio TEXT,
    location VARCHAR(255),
    phone VARCHAR(50),
    date_of_birth DATE,
    is_verified BOOLEAN DEFAULT FALSE,
    is_seller_verified BOOLEAN DEFAULT FALSE,
    stripe_customer_id VARCHAR(255),
    stripe_connect_id VARCHAR(255),
    stripe_connect_onboarded BOOLEAN DEFAULT FALSE,
    total_sales INTEGER DEFAULT 0,
    total_purchases INTEGER DEFAULT 0,
    average_rating DECIMAL(3,2) DEFAULT 0,
    review_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_login TIMESTAMP,
    push_token VARCHAR(255),
    notification_preferences JSONB
);

-- Email suppressions (base table - no dependencies)
CREATE TABLE email_suppressions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    reason VARCHAR(255) NOT NULL,
    bounce_type VARCHAR(100),
    bounce_subtype VARCHAR(100),
    source VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Golf brands reference table
CREATE TABLE golf_brands (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(255),
    logo_url VARCHAR(500),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Shaft specifications reference table
CREATE TABLE shaft_specifications (
    id SERIAL PRIMARY KEY,
    brand VARCHAR(255) NOT NULL,
    model VARCHAR(255) NOT NULL,
    flex VARCHAR(50),
    weight VARCHAR(50),
    launch VARCHAR(50),
    spin VARCHAR(50),
    shaft_type VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Push tokens table (depends on users but can exist independently)
CREATE TABLE push_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL,
    token VARCHAR(500) NOT NULL,
    platform VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- STEP 2: SECOND-LEVEL TABLES (depend on base tables)
-- ============================================

-- Golf models (depends on golf_brands)
CREATE TABLE golf_models (
    id SERIAL PRIMARY KEY,
    brand_id INTEGER REFERENCES golf_brands(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100),
    year_released INTEGER,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Listings (depends on users)
CREATE TABLE listings (
    id VARCHAR(255) PRIMARY KEY,
    seller_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    category VARCHAR(100) NOT NULL,
    subcategory VARCHAR(100),
    brand VARCHAR(255),
    model VARCHAR(255),
    price DECIMAL(10,2) NOT NULL,
    original_price DECIMAL(10,2),
    currency VARCHAR(10) DEFAULT 'GBP',
    status VARCHAR(50) DEFAULT 'active',
    location VARCHAR(255),
    is_featured BOOLEAN DEFAULT FALSE,
    is_negotiable BOOLEAN DEFAULT TRUE,
    views INTEGER DEFAULT 0,
    favorites_count INTEGER DEFAULT 0,
    condition_overall INTEGER,
    condition_head INTEGER,
    condition_shaft INTEGER,
    condition_grip INTEGER,
    ball_condition_type VARCHAR(100),
    specifications JSONB,
    parcel_size VARCHAR(50),
    shipping_cost DECIMAL(10,2),
    quantity INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Blocked users (depends on users)
CREATE TABLE blocked_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blocker_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(blocker_id, blocked_id)
);

-- User reports (depends on users)
CREATE TABLE user_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason VARCHAR(255) NOT NULL,
    details TEXT,
    conversation_id VARCHAR(255),
    listing_id VARCHAR(255),
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- STEP 3: THIRD-LEVEL TABLES (depend on listings/users)
-- ============================================

-- Images (depends on listings)
CREATE TABLE images (
    id VARCHAR(255) PRIMARY KEY,
    listing_id VARCHAR(255) NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    image_url VARCHAR(500) NOT NULL,
    s3_key VARCHAR(500) NOT NULL,
    is_primary BOOLEAN DEFAULT FALSE,
    display_order INTEGER DEFAULT 0,
    alt_text VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Listing attributes (depends on listings)
CREATE TABLE listing_attributes (
    id VARCHAR(255) PRIMARY KEY,
    listing_id VARCHAR(255) NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    key VARCHAR(255) NOT NULL,
    value VARCHAR(500) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Favorites (depends on users and listings)
CREATE TABLE favorites (
    id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listing_id VARCHAR(255) NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, listing_id)
);

-- Cart items (depends on users and listings)
CREATE TABLE cart_items (
    id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listing_id VARCHAR(255) NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    quantity INTEGER DEFAULT 1,
    selected_size VARCHAR(50),
    added_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    UNIQUE(user_id, listing_id, selected_size)
);

-- Conversations (depends on users and listings)
CREATE TABLE conversations (
    id VARCHAR(255) PRIMARY KEY,
    listing_id VARCHAR(255) NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    buyer_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_message_at TIMESTAMP DEFAULT NOW(),
    is_archived BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(listing_id, buyer_id)
);

-- Orders (depends on users and listings)
CREATE TABLE orders (
    id VARCHAR(255) PRIMARY KEY,
    listing_id VARCHAR(255) REFERENCES listings(id) ON DELETE SET NULL,
    buyer_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'GBP',
    stripe_payment_intent_id VARCHAR(255),
    stripe_payment_method_id VARCHAR(255),
    stripe_transfer_id VARCHAR(255),
    status VARCHAR(50) DEFAULT 'pending',
    shipping_address JSONB,
    tracking_number VARCHAR(255),
    carrier VARCHAR(100),
    shipping_cost DECIMAL(10,2),
    seller_payout DECIMAL(10,2),
    label_url TEXT,
    label_cost DECIMAL(10,2),
    shippo_shipment_id VARCHAR(255),
    shippo_transaction_id VARCHAR(255),
    quantity INTEGER DEFAULT 1,
    listing_title VARCHAR(500),
    listing_image VARCHAR(500),
    listing_price DECIMAL(10,2),
    selected_size VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    paid_at TIMESTAMP,
    shipped_at TIMESTAMP,
    delivered_at TIMESTAMP,
    completed_at TIMESTAMP,
    cancelled_at TIMESTAMP,
    cancel_reason TEXT,
    auto_cancel_at TIMESTAMP,
    disputed_at TIMESTAMP,
    dispute_reason TEXT,
    buyer_viewed_at TIMESTAMP,
    escrow_release_at TIMESTAMP,
    reported_lost_at TIMESTAMP,
    lost_notification_sent_at TIMESTAMP,
    refunded_at TIMESTAMP,
    refund_amount DECIMAL(10,2),
    stripe_refund_id VARCHAR(255),
    insurance_premium DECIMAL(10,2),
    insured_value DECIMAL(10,2),
    insurance_claim_status VARCHAR(100),
    insurance_claim_id VARCHAR(255)
);

-- Support tickets (depends on users and orders)
CREATE TABLE support_tickets (
    id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id VARCHAR(255) REFERENCES orders(id) ON DELETE SET NULL,
    subject VARCHAR(500) NOT NULL,
    description TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'open',
    priority VARCHAR(50) DEFAULT 'normal',
    category VARCHAR(100),
    assigned_to VARCHAR(255),
    resolution TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    resolved_at TIMESTAMP
);

-- ============================================
-- STEP 4: FOURTH-LEVEL TABLES (depend on third-level)
-- ============================================

-- Messages (depends on conversations and users)
CREATE TABLE messages (
    id VARCHAR(255) PRIMARY KEY,
    conversation_id VARCHAR(255) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    message_type VARCHAR(50) DEFAULT 'text',
    offer_amount DECIMAL(10,2),
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Reviews (depends on orders and users)
CREATE TABLE reviews (
    id VARCHAR(255) PRIMARY KEY,
    order_id VARCHAR(255) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    reviewer_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reviewed_user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    review_text TEXT,
    review_type VARCHAR(50) NOT NULL,
    is_public BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(order_id, reviewer_id)
);

-- Disputes (depends on orders and users)
CREATE TABLE disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id VARCHAR(255) UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    buyer_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'open',
    reason_type VARCHAR(100) NOT NULL,
    reason_text TEXT NOT NULL,
    requested_refund_percent INTEGER NOT NULL,
    requested_refund_amount DECIMAL(10,2) NOT NULL,
    seller_response_type VARCHAR(50),
    counter_offer_percent INTEGER,
    counter_offer_amount DECIMAL(10,2),
    seller_response_text TEXT,
    seller_responded_at TIMESTAMP,
    resolution_type VARCHAR(50),
    resolution_amount DECIMAL(10,2),
    resolution_notes TEXT,
    resolved_by VARCHAR(50),
    resolved_at TIMESTAMP,
    seller_deadline TIMESTAMP NOT NULL,
    auto_escalated BOOLEAN DEFAULT FALSE,
    escalated_at TIMESTAMP,
    escalation_reason TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Support ticket images (depends on support_tickets)
CREATE TABLE support_ticket_images (
    id VARCHAR(255) PRIMARY KEY,
    ticket_id VARCHAR(255) NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    image_url VARCHAR(500) NOT NULL,
    s3_key VARCHAR(500) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- STEP 5: FIFTH-LEVEL TABLES (depend on fourth-level)
-- ============================================

-- Dispute images (depends on disputes)
CREATE TABLE dispute_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_id UUID NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
    image_url VARCHAR(500) NOT NULL,
    s3_key VARCHAR(500) NOT NULL,
    uploaded_by VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Return requests (depends on orders and disputes)
CREATE TABLE return_requests (
    id VARCHAR(255) PRIMARY KEY,
    order_id VARCHAR(255) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    dispute_id UUID REFERENCES disputes(id) ON DELETE SET NULL,
    requested_by VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    approved_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
    reason VARCHAR(100) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    return_label_url TEXT,
    return_tracking_number VARCHAR(255),
    return_carrier VARCHAR(100),
    label_cost DECIMAL(10,2),
    paid_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
    shippo_transaction_id VARCHAR(255),
    refund_amount DECIMAL(10,2),
    shipping_deducted DECIMAL(10,2),
    stripe_refund_id VARCHAR(255),
    return_ship_deadline TIMESTAMP,
    shipped_at TIMESTAMP,
    delivered_at TIMESTAMP,
    escrow_release_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- STEP 6: CREATE INDEXES
-- ============================================

-- Users indexes
CREATE INDEX idx_users_cognito_id ON users(cognito_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_stripe_connect_id ON users(stripe_connect_id);

-- Listings indexes
CREATE INDEX idx_listings_seller_id ON listings(seller_id);
CREATE INDEX idx_listings_status ON listings(status);
CREATE INDEX idx_listings_category ON listings(category);
CREATE INDEX idx_listings_subcategory ON listings(subcategory);
CREATE INDEX idx_listings_brand ON listings(brand);
CREATE INDEX idx_listings_price ON listings(price);
CREATE INDEX idx_listings_location ON listings(location);
CREATE INDEX idx_listings_created_at ON listings(created_at);
CREATE INDEX idx_listings_condition_overall ON listings(condition_overall);

-- Images indexes
CREATE INDEX idx_images_listing_id ON images(listing_id);
CREATE INDEX idx_images_listing_primary ON images(listing_id, is_primary);

-- Listing attributes indexes
CREATE INDEX idx_listing_attributes_listing_id ON listing_attributes(listing_id);
CREATE INDEX idx_listing_attributes_key ON listing_attributes(key);
CREATE INDEX idx_listing_attributes_key_value ON listing_attributes(key, value);

-- Favorites indexes
CREATE INDEX idx_favorites_user_id ON favorites(user_id);
CREATE INDEX idx_favorites_listing_id ON favorites(listing_id);

-- Conversations indexes
CREATE INDEX idx_conversations_buyer_id ON conversations(buyer_id);
CREATE INDEX idx_conversations_seller_id ON conversations(seller_id);
CREATE INDEX idx_conversations_listing_id ON conversations(listing_id);

-- Messages indexes
CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_messages_sender_id ON messages(sender_id);
CREATE INDEX idx_messages_receiver_id ON messages(receiver_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);

-- Orders indexes
CREATE INDEX idx_orders_buyer_id ON orders(buyer_id);
CREATE INDEX idx_orders_seller_id ON orders(seller_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_orders_auto_cancel_at ON orders(auto_cancel_at);

-- Reviews indexes
CREATE INDEX idx_reviews_reviewed_user_id ON reviews(reviewed_user_id);
CREATE INDEX idx_reviews_reviewer_id ON reviews(reviewer_id);
CREATE INDEX idx_reviews_order_id ON reviews(order_id);

-- Disputes indexes
CREATE INDEX idx_disputes_order_id ON disputes(order_id);
CREATE INDEX idx_disputes_buyer_id ON disputes(buyer_id);
CREATE INDEX idx_disputes_seller_id ON disputes(seller_id);
CREATE INDEX idx_disputes_status ON disputes(status);
CREATE INDEX idx_disputes_seller_deadline ON disputes(seller_deadline);
CREATE INDEX idx_disputes_created_at ON disputes(created_at);

-- Support tickets indexes
CREATE INDEX idx_support_tickets_user_id ON support_tickets(user_id);
CREATE INDEX idx_support_tickets_order_id ON support_tickets(order_id);
CREATE INDEX idx_support_tickets_status ON support_tickets(status);

-- Cart items indexes
CREATE INDEX idx_cart_items_user_id ON cart_items(user_id);
CREATE INDEX idx_cart_items_listing_id ON cart_items(listing_id);
CREATE INDEX idx_cart_items_expires_at ON cart_items(expires_at);

-- Email suppressions indexes
CREATE INDEX idx_email_suppressions_email ON email_suppressions(email);
CREATE INDEX idx_email_suppressions_reason ON email_suppressions(reason);

-- User reports indexes
CREATE INDEX idx_user_reports_reporter_id ON user_reports(reporter_id);
CREATE INDEX idx_user_reports_reported_user_id ON user_reports(reported_user_id);
CREATE INDEX idx_user_reports_status ON user_reports(status);

-- Blocked users indexes
CREATE INDEX idx_blocked_users_blocker_id ON blocked_users(blocker_id);
CREATE INDEX idx_blocked_users_blocked_id ON blocked_users(blocked_id);

-- Return requests indexes
CREATE INDEX idx_return_requests_order_id ON return_requests(order_id);
CREATE INDEX idx_return_requests_dispute_id ON return_requests(dispute_id);
CREATE INDEX idx_return_requests_status ON return_requests(status);

-- Dispute images indexes
CREATE INDEX idx_dispute_images_dispute_id ON dispute_images(dispute_id);

-- Support ticket images indexes
CREATE INDEX idx_support_ticket_images_ticket_id ON support_ticket_images(ticket_id);

-- ============================================
-- VERIFICATION QUERY
-- Run this after recreation to verify all tables exist:
-- ============================================

-- SELECT table_name FROM information_schema.tables 
-- WHERE table_schema = 'public' 
-- ORDER BY table_name;

-- Expected: 20+ tables including users, listings, orders, etc.

-- ============================================
-- END OF RECREATION SCRIPT
-- ============================================