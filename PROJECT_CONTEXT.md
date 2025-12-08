# MULLIGANS MVP - COMPLETE PROJECT DOCUMENTATION

## EXECUTIVE SUMMARY

**Project Name:** Mulligans MVP  
**Project Type:** Golf Equipment Marketplace (Mobile-First)  
**Developer:** Solo entrepreneur, first coding project ever  
**Current Status:** Completed web application, actively translating to React Native mobile app  
**Goal:** Launch MVP, attract users, secure investment  
**Development Started:** Several months ago from absolute beginner  
**Business Model:** Peer-to-peer marketplace for buying/selling golf equipment  

---

## TABLE OF CONTENTS
1. Project Origin & Philosophy
2. Technical Architecture Overview
3. Frontend - Web Application (Completed)
4. Frontend - Mobile Application (In Progress)
5. Backend System Architecture
6. Database Schema & Data Models
7. AWS Infrastructure & Services
8. Authentication System
9. Core Features & Systems
10. API Endpoints Reference
11. Known Issues & Resolutions
12. Development History Timeline
13. Cost Management & AWS Free Tier
14. Developer Preferences & Workflow
15. Next Steps & Future Plans

---

## 1. PROJECT ORIGIN & PHILOSOPHY

### The Beginning
- Absolute beginner with ZERO prior programming experience
- Strong interest in golf and marketplace dynamics
- Decided to build a marketplace for golf equipment as first project
- Learned full-stack development from scratch during this project
- Consulted with software developer mentor/advisor for guidance

### Original Vision vs MVP Scope
**Original Wishlist:** 19 pages of features  
**Defined MVP Scope:** 9 essential pages focusing on core marketplace functionality

**MVP Decision Rationale:**
- Faster market validation
- Focus on core value proposition
- Defer payment integration to post-launch
- Mobile-first approach based on advisor recommendation

### Business Strategy
- Launch with essential features first
- Validate market demand
- Seek investment after demonstrating traction
- Most users expected to access via mobile (hence mobile-first approach)

---

## 2. TECHNICAL ARCHITECTURE OVERVIEW

### Technology Stack Summary

**Frontend (Web - Completed):**
- React with Next.js
- TypeScript
- Responsive design for desktop/tablet/mobile browsers
- AWS S3 for image hosting

**Frontend (Mobile - In Progress):**
- React Native
- Expo Router (file-based routing)
- TypeScript
- Tab navigation architecture
- Exact feature parity with web version

**Backend:**
- Node.js
- Express.js
- TypeScript
- Prisma ORM (database abstraction layer)
- Socket.io (real-time messaging)

**Database:**
- PostgreSQL
- Hosted on AWS RDS
- Located in London region (eu-west-2)

**Cloud Infrastructure:**
- AWS (London region: eu-west-2)
- RDS (PostgreSQL database)
- S3 (image storage)
- Cognito (user authentication)
- EC2 (backend hosting - stopped when not developing to save costs)

**Development Environment:**
- Local development machine
- Backend accessible at: http://192.168.1.214:3000
- Git version control (recommended)

---

## 3. FRONTEND - WEB APPLICATION (COMPLETED)

### Technology Details
- **Framework:** Next.js (React framework with server-side rendering)
- **Language:** TypeScript
- **Styling:** Responsive design (mobile-first approach)
- **State Management:** React Context for authentication state
- **Image Handling:** AWS S3 URLs, image carousels for listings

### Page Structure (9 Core Pages)
1. **Login Page** - User authentication
2. **Register Page** - New user signup
3. **Home/Feed Page** - Browse all listings
4. **Search Page** - Advanced filtering and search
5. **Messages Page** - Real-time chat between buyers/sellers
6. **Favorites Page** - Saved listings
7. **Profile Page** - User/seller profiles with their listings
8. **Listing Detail Page** - Full details of single listing
9. **Create Listing Page** - Post new equipment for sale

### Key Features Implemented
- User authentication with AWS Cognito
- Image uploads to S3 (multiple images per listing)
- Image carousels for viewing listing photos
- Advanced search with golf-specific filters
- Real-time messaging system
- Favorites/saved listings functionality
- Seller profile pages showing all their listings
- Notifications for messages and favorites
- Comprehensive golf equipment specification forms
- Category-specific dynamic filters
- Separate condition ratings for club components
- Golf brands organized by popularity

### Web App Status
**Status:** Fully functional and complete  
**Purpose:** Built first for faster market validation  
**Next Step:** Mobile app translation (in progress)

---

## 4. FRONTEND - MOBILE APPLICATION (IN PROGRESS)

### Translation Strategy
**Approach:** Systematic translation from Next.js web app to React Native  
**Goal:** Exact feature parity with web version  
**Reason:** Mobile is where most users will access the platform (advisor recommendation)

### Technology Details
- **Framework:** React Native
- **Navigation:** Expo Router (file-based routing system)
- **Language:** TypeScript
- **Backend Connection:** Same API at http://192.168.1.214:3000
- **Image Handling:** Same S3 infrastructure as web app

### Screen Structure (9 Core Screens - Matches Web)
1. **LoginScreen** - User authentication
2. **RegisterScreen** - New user signup  
3. **HomeScreen** - Browse listings feed (Tab 1)
4. **SearchScreen** - Advanced filtering (Tab 2)
5. **MessagesScreen** - Real-time chat (Tab 3)
6. **FavoritesScreen** - Saved listings (Tab 4)
7. **ProfileScreen** - User profile (Tab 5)
8. **ListingDetailScreen** - Full listing details (modal/stack)
9. **CreateListingScreen** - Post new listing (modal/stack)

### Navigation Architecture
**Tab Navigation (5 tabs):**
- Home (feed)
- Search
- Messages
- Favorites  
- Profile

**Stack Navigation (overlays):**
- Listing Details (opens from any tab)
- Create Listing (opens from Home/Profile)

### Current Challenges Being Resolved
1. **Import Path Issues**
   - Translating Next.js imports to React Native equivalents
   - Different module systems between web and mobile

2. **Dependency Conflicts**
   - React Native has different compatible libraries than Next.js
   - Finding mobile equivalents for web libraries

3. **Authentication Context**
   - Ensuring Cognito auth works properly in React Native
   - Managing authentication state across screens
   - Critical: Backend must use database user IDs, not Cognito IDs

4. **Navigation Context**
   - Expo Router works differently than Next.js routing
   - Deep linking setup
   - Tab navigation state management

### Mobile App Status
**Status:** In active development, debugging phase  
**Completion:** Core structure built, resolving integration issues  
**Timeline:** Actively working through import/dependency/auth issues

---

## 5. BACKEND SYSTEM ARCHITECTURE

### Core Technology Stack
- **Runtime:** Node.js
- **Framework:** Express.js
- **Language:** TypeScript
- **ORM:** Prisma (database abstraction)
- **Real-Time:** Socket.io (websocket connections)
- **API Style:** RESTful with Socket.io for messaging

### Backend Server Details
- **Local Development IP:** 192.168.1.214
- **Port:** 3000
- **Base URL:** http://192.168.1.214:3000
- **API Prefix:** /api
- **Socket.io Endpoint:** Same server, different protocol

### Four Major Backend Systems

#### System 1: Authentication API
**Purpose:** User registration, login, session management  
**Integration:** AWS Cognito for identity management  
**Endpoints:**
- POST /api/auth/register - New user signup
- POST /api/auth/login - User login
- POST /api/auth/logout - User logout
- GET /api/auth/verify - Token verification
- POST /api/auth/refresh - Refresh auth tokens

**Critical Implementation Detail:**
- Backend stores users in PostgreSQL database
- AWS Cognito provides authentication tokens
- **IMPORTANT:** System uses database user IDs (from PostgreSQL), NOT Cognito IDs
- This was a major bug that was fixed early on

#### System 2: Listings API
**Purpose:** CRUD operations for equipment listings  
**Features:**
- Create new listings with multiple images
- Read/view listings (single or all)
- Update existing listings
- Delete listings
- Upload images to S3
- Generate presigned S3 URLs for image access

**Endpoints:**
- POST /api/listings - Create new listing
- GET /api/listings - Get all listings (with pagination)
- GET /api/listings/:id - Get single listing details
- PUT /api/listings/:id - Update listing
- DELETE /api/listings/:id - Delete listing
- POST /api/listings/images - Upload images to S3

#### System 3: Search API
**Purpose:** Advanced filtering and search functionality  
**Features:**
- Keyword search across titles and descriptions
- Category-specific filtering
- Golf-specific attribute filtering (flex, loft, shaft type, etc.)
- Condition filtering
- Price range filtering
- Location-based search
- Sort options (price, date, condition)

**Endpoints:**
- GET /api/search - Advanced search with query parameters
- POST /api/search/filters - Get available filter options for category

**Golf Equipment Specifications:**
- Comprehensive specification system
- Category-specific filters (drivers, irons, putters, etc.)
- Dynamic forms based on equipment category
- Separate condition ratings for:
  - Club head condition
  - Shaft condition
  - Grip condition
  - Overall club condition
- Golf brands organized by popularity tiers

#### System 4: Messaging API + Socket.io
**Purpose:** Real-time chat between buyers and sellers  
**Technology:** REST API + Socket.io websockets  

**REST Endpoints:**
- GET /api/messages/conversations - Get all user conversations
- GET /api/messages/:conversationId - Get messages in conversation
- POST /api/messages - Send new message (also broadcasts via socket)
- PUT /api/messages/:messageId/read - Mark message as read

**Socket.io Events:**
- Connection: Client connects with auth token
- 'join_conversation': Join specific conversation room
- 'new_message': Broadcast new message to conversation participants
- 'message_read': Notify when message is read
- 'typing': Real-time typing indicators

**Notifications Integration:**
- New message notifications
- Unread message counts
- Real-time updates without page refresh

### Additional Backend Features

#### Favorites System
**Endpoints:**
- POST /api/favorites/:listingId - Add to favorites
- DELETE /api/favorites/:listingId - Remove from favorites
- GET /api/favorites - Get user's favorited listings

**Features:**
- Notifications when favorited items have price changes
- Track which users favorited which listings

#### User Profiles
**Endpoints:**
- GET /api/users/:userId - Get public profile
- GET /api/users/:userId/listings - Get user's active listings
- PUT /api/users/profile - Update own profile
- GET /api/users/me - Get own full profile

**Profile Information:**
- Username
- Bio/description
- Location
- Member since date
- Active listings count
- Seller ratings (future feature)

#### Notifications System
**Endpoints:**
- GET /api/notifications - Get user notifications
- PUT /api/notifications/:id/read - Mark notification as read
- DELETE /api/notifications/:id - Delete notification

**Notification Types:**
- New messages
- Favorites updates
- Listing interactions
- System announcements

---

## 6. DATABASE SCHEMA & DATA MODELS

### Prisma ORM
**Purpose:** Type-safe database queries, automatic migrations, schema management  
**Schema File:** `prisma/schema.prisma`

### Core Database Tables (Models)

#### Users Table
```
Model: User
Purpose: Store user account information
Key Fields:
  - id (UUID, primary key)
  - cognitoId (String, AWS Cognito identifier)
  - email (String, unique)
  - username (String, unique)
  - firstName (String)
  - lastName (String)
  - phoneNumber (String, optional)
  - bio (Text, optional)
  - location (String, optional)
  - profileImageUrl (String, optional)
  - createdAt (DateTime)
  - updatedAt (DateTime)

Relationships:
  - One-to-Many: User → Listings (user can create many listings)
  - One-to-Many: User → Messages (user can send many messages)
  - One-to-Many: User → Favorites (user can favorite many listings)
  - One-to-Many: User → Conversations (user can have many conversations)
```

#### Listings Table
```
Model: Listing
Purpose: Store equipment listings for sale
Key Fields:
  - id (UUID, primary key)
  - userId (UUID, foreign key to User)
  - title (String)
  - description (Text)
  - category (String) - e.g., "drivers", "irons", "putters"
  - brand (String)
  - model (String)
  - condition (String) - overall condition rating
  - conditionDetails (JSON) - component-specific conditions
  - price (Decimal)
  - currency (String, default "USD")
  - location (String)
  - specifications (JSON) - golf-specific attributes
  - images (String array) - S3 URLs
  - status (String) - "active", "sold", "removed"
  - viewCount (Integer)
  - favoriteCount (Integer)
  - createdAt (DateTime)
  - updatedAt (DateTime)

Golf Specifications JSON includes:
  - flex (for clubs)
  - loft (for drivers, woods)
  - shaftMaterial
  - shaftType
  - lie angle
  - clubLength
  - gripType
  - handedness (left/right)
  - yearManufactured

Relationships:
  - Many-to-One: Listing → User (listing belongs to one seller)
  - One-to-Many: Listing → Favorites
  - Referenced in Messages (for context)
```

#### Messages Table
```
Model: Message
Purpose: Store individual chat messages
Key Fields:
  - id (UUID, primary key)
  - conversationId (UUID, foreign key to Conversation)
  - senderId (UUID, foreign key to User)
  - content (Text)
  - isRead (Boolean)
  - readAt (DateTime, optional)
  - attachmentUrl (String, optional) - for image attachments
  - createdAt (DateTime)

Relationships:
  - Many-to-One: Message → Conversation
  - Many-to-One: Message → User (sender)
```

#### Conversations Table
```
Model: Conversation
Purpose: Group messages between two users about a listing
Key Fields:
  - id (UUID, primary key)
  - listingId (UUID, foreign key to Listing)
  - buyerId (UUID, foreign key to User)
  - sellerId (UUID, foreign key to User)
  - lastMessageAt (DateTime)
  - lastMessagePreview (String)
  - createdAt (DateTime)
  - updatedAt (DateTime)

Relationships:
  - One-to-Many: Conversation → Messages
  - Many-to-One: Conversation → Listing (what they're discussing)
  - Many-to-One: Conversation → User (buyer)
  - Many-to-One: Conversation → User (seller)

Business Logic:
  - One conversation per buyer-seller-listing combination
  - Prevents duplicate conversations
```

#### Favorites Table
```
Model: Favorite
Purpose: Track which users favorited which listings
Key Fields:
  - id (UUID, primary key)
  - userId (UUID, foreign key to User)
  - listingId (UUID, foreign key to Listing)
  - createdAt (DateTime)

Relationships:
  - Many-to-One: Favorite → User
  - Many-to-One: Favorite → Listing

Constraints:
  - Unique combination of userId + listingId (can't favorite twice)
```

#### Notifications Table
```
Model: Notification
Purpose: Store user notifications
Key Fields:
  - id (UUID, primary key)
  - userId (UUID, foreign key to User)
  - type (String) - "message", "favorite", "price_change"
  - content (String)
  - relatedId (UUID, optional) - ID of related entity
  - isRead (Boolean)
  - createdAt (DateTime)

Relationships:
  - Many-to-One: Notification → User
```

### Database Relationships Summary
- Users create Listings (one-to-many)
- Users send Messages (one-to-many)
- Users have Favorites (one-to-many)
- Conversations contain Messages (one-to-many)
- Conversations link Buyer + Seller + Listing (many-to-one for each)
- Listings can be favorited by many Users (many-to-many via Favorites table)

---

## 7. AWS INFRASTRUCTURE & SERVICES

### AWS Region
**Primary Region:** eu-west-2 (London)  
**Reason:** Closest to developer location, data sovereignty  
**CRITICAL:** All services MUST be in London region

### AWS Services In Use

#### 1. AWS RDS (Relational Database Service)
**Purpose:** Hosted PostgreSQL database  
**Configuration:**
- Engine: PostgreSQL (specific version TBD)
- Instance Type: Free tier eligible (db.t3.micro or db.t4g.micro)
- Storage: 20GB (free tier limit)
- Backup: Automated daily backups
- Multi-AZ: No (cost saving)
- Public Access: No (security)

**Connection Details:**
- Accessed by backend via VPC/security group
- Connection string stored in backend environment variables
- SSL/TLS encryption enforced

**Free Tier Status:** Active, monitoring usage carefully

#### 2. AWS S3 (Simple Storage Service)
**Purpose:** Image storage for listing photos  
**Bucket Configuration:**
- Bucket Name: [specific bucket name in use]
- Region: eu-west-2 (London)
- Public Access: Configured for specific public read via presigned URLs
- Versioning: Disabled (cost saving)

**Image Upload Flow:**
1. Frontend/mobile app requests upload permission
2. Backend generates presigned POST URL
3. Client uploads directly to S3
4. S3 URL stored in Listing record
5. Images served via presigned GET URLs (time-limited for security)

**Folder Structure:**
```
mulligans-listings/
  ├── user-{userId}/
      ├── listing-{listingId}/
          ├── image1.jpg
          ├── image2.jpg
          └── ...
```

**S3 Permissions Issues (RESOLVED):**
- Initially had permission errors for image display
- Fixed by properly configuring bucket policy
- Presigned URLs now work correctly
- Images display properly in web and mobile apps

**Free Tier Status:** Within 5GB storage limit, monitoring usage

#### 3. AWS Cognito
**Purpose:** User authentication and identity management  
**Configuration:**
- User Pool: Configured for email + password authentication
- Multi-factor Authentication: Optional (not required for MVP)
- Password Policy: Standard complexity requirements
- Email Verification: Required for new accounts

**Authentication Flow:**
1. User registers → Cognito creates identity
2. Cognito sends verification email
3. User verifies email
4. User logs in → Cognito issues JWT tokens
5. Backend creates User record in PostgreSQL with Cognito ID reference
6. Frontend stores tokens for API authentication

**CRITICAL IMPLEMENTATION DETAIL:**
- Cognito provides authentication (tokens, session management)
- PostgreSQL stores user profile data
- **Backend uses PostgreSQL user ID for all operations**
- **NOT Cognito ID** (this was a major bug that was fixed)

**Token Management:**
- Access tokens (short-lived, ~1 hour)
- Refresh tokens (longer-lived, ~30 days)
- ID tokens (user information)

**Free Tier Status:** Within 50,000 MAU (monthly active users) limit

#### 4. AWS EC2 (Elastic Compute Cloud)
**Purpose:** Backend API hosting  
**Configuration:**
- Instance Type: t2.micro or t3.micro (free tier)
- Operating System: Linux (Amazon Linux 2 or Ubuntu)
- Storage: 30GB EBS volume (free tier)
- Security Group: Configured for HTTP/HTTPS + SSH access

**Backend Deployment:**
- Node.js application running on EC2
- Managed with PM2 (process manager) or similar
- Nginx reverse proxy (optional)
- Environment variables configured

**Development Practice:**
- **STOP EC2 instance when not actively developing**
- Reason: Save costs, stay within free tier
- Start only when coding/testing
- Backend accessible at: http://192.168.1.214:3000 when running

**Free Tier Status:** 750 hours/month (sufficient for development)

### AWS Cost Management History

#### The Stockholm Incident (RESOLVED)
**Problem:** Duplicate infrastructure discovered in Stockholm region (eu-north-1)  
**Cost Impact:** $170 per month unexpected charges  
**Cause:** Accidentally created resources in wrong region  
**Resolution:** Systematically deleted all Stockholm resources  
**Preserved:** All London (eu-west-2) development environment intact  
**Lesson Learned:** Always verify region before creating resources

#### Current Cost Management Strategy
1. **Free Tier Monitoring:**
   - Regularly check AWS billing dashboard
   - Set up billing alerts at $10, $20 thresholds
   - Review usage metrics weekly

2. **Resource Management:**
   - Stop EC2 instances when not developing
   - Delete unused S3 objects periodically
   - Minimize RDS backup retention
   - No unnecessary data transfer

3. **Development Practices:**
   - Work in focused sessions to minimize EC2 runtime
   - Test locally when possible
   - Batch uploads to S3
   - Optimize image sizes before upload

**Current Monthly Costs:** Targeting $0-5 within free tier

### Security Considerations
- VPC configuration for network isolation
- Security groups with minimal necessary access
- No public database access
- Encrypted data at rest (RDS, S3)
- Encrypted data in transit (HTTPS, TLS)
- IAM roles with least privilege principle
- Regular security group audits

---

## 8. AUTHENTICATION SYSTEM

### Architecture Overview
**Flow:** Frontend → AWS Cognito → Backend → PostgreSQL

### Complete Authentication Flow

#### Registration Process
1. **User fills registration form:**
   - Email address
   - Password (meets complexity requirements)
   - Username
   - Optional: First name, last name, phone

2. **Frontend sends to Cognito:**
   - Cognito validates email format
   - Cognito checks password strength
   - Cognito creates user identity

3. **Cognito sends verification email:**
   - User receives email with code
   - User enters verification code
   - Account becomes verified

4. **Backend creates database record:**
   - Receives Cognito ID
   - Creates User record in PostgreSQL
   - Stores: cognitoId, email, username, profile data
   - Generates unique database user ID (UUID)

5. **User can now log in**

#### Login Process
1. **User enters credentials:**
   - Email + password

2. **Cognito validates:**
   - Checks credentials
   - Issues tokens if valid:
     - Access token (short-lived)
     - Refresh token (long-lived)  
     - ID token (user information)

3. **Frontend stores tokens:**
   - Secure storage (AsyncStorage on mobile, localStorage/sessionStorage on web)
   - Tokens included in API requests

4. **Backend validates tokens:**
   - Extracts Cognito ID from token
   - Looks up User in PostgreSQL by cognitoId
   - **Uses database user ID for all operations**

5. **User is authenticated**

#### Token Management
**Access Token:**
- Purpose: Authorize API requests
- Lifespan: ~1 hour
- Included in Authorization header: `Bearer {accessToken}`
- Validated by backend on each request

**Refresh Token:**
- Purpose: Get new access tokens without re-login
- Lifespan: ~30 days
- Stored securely
- Used when access token expires

**ID Token:**
- Purpose: Contains user information
- Includes: email, username, Cognito ID
- Used by frontend for display

#### Session Management
**Web Application:**
- Tokens in localStorage or sessionStorage
- Auth context provider wraps entire app
- Automatic token refresh when expired
- Redirect to login if refresh fails

**Mobile Application:**
- Tokens in AsyncStorage (encrypted on device)
- Auth context provider wraps entire app
- Automatic token refresh when expired
- Navigate to login screen if refresh fails

### Critical Bug That Was Fixed

#### The Cognito ID vs Database ID Problem
**Original Problem:**
- Backend was using Cognito IDs for database operations
- Should have been using PostgreSQL user IDs
- Caused data association errors
- Messages, listings, favorites linked to wrong IDs

**The Fix:**
1. Backend now uses Cognito ID ONLY for authentication
2. Immediately looks up User record in PostgreSQL
3. Uses database user ID (UUID) for all operations
4. Cognito ID stored as reference field only

**Current Correct Flow:**
```
1. Frontend sends request with Cognito access token
2. Backend validates token → extracts Cognito ID
3. Backend queries: SELECT * FROM users WHERE cognitoId = {extractedId}
4. Backend uses user.id (database ID) for all subsequent operations
5. All listings, messages, favorites use database user ID
```

**Status:** Fully resolved and working correctly

### Authentication Context Implementation

**Purpose:** Manage authentication state across entire app  
**Location:** Root level of application  
**Provides:**
- Current user information
- Login function
- Logout function  
- Register function
- Token refresh function
- Loading states
- Error states

**React Context Pattern:**
```
<AuthProvider>
  <App>
    <Navigation>
      <Screens />
    </Navigation>
  </App>
</AuthProvider>
```

All screens can access authentication state and functions via useAuth() hook.

### Security Measures
- Passwords never stored in plain text (Cognito handles hashing)
- Tokens have expiration times
- Refresh tokens can be revoked
- Email verification required
- HTTPS for all authentication requests
- SQL injection prevented by Prisma parameterization
- XSS protection via React's built-in escaping

---

## 9. CORE FEATURES & SYSTEMS

### Feature 1: Equipment Listings

#### Listing Creation
**User Flow:**
1. User clicks "Create Listing" button
2. Form appears with category selection
3. Category-specific fields appear dynamically
4. User fills in:
   - Title
   - Description  
   - Category (dropdown)
   - Brand (searchable, organized by popularity)
   - Model
   - Price
   - Location
   - Condition (overall + component-specific)
   - Golf-specific attributes
   - Photos (up to 8 images)

**Golf-Specific Specifications:**

**For Clubs (Drivers, Woods, Hybrids, Irons, Wedges):**
- Handedness (left/right)
- Shaft flex (Extra Stiff, Stiff, Regular, Senior, Ladies)
- Shaft material (Steel, Graphite, Multi-material)
- Shaft type/brand
- Club length
- Lie angle
- Loft (for drivers/woods)
- Grip type
- Year manufactured

**Component Condition Ratings:**
- Club head condition (1-10 scale)
- Shaft condition (1-10 scale)
- Grip condition (1-10 scale)
- Overall club condition (1-10 scale)

**For Putters:**
- Handedness
- Putter length
- Head shape (blade, mallet, etc.)
- Grip type
- Overall condition

**For Golf Balls:**
- Brand
- Model
- Quantity
- Condition grade
- Year/season

**For Golf Bags:**
- Type (stand, cart, travel)
- Number of dividers
- Rain hood included
- Stand type (if applicable)
- Weight
- Condition

**For Accessories:**
- Type (rangefinder, GPS, training aids, etc.)
- Brand
- Model
- Battery status
- Condition

**Brand Organization:**
- Brands sorted by popularity (most common first)
- Popular brands: Titleist, Callaway, TaylorMade, Ping, etc.
- Less common brands after popular ones
- Custom/other option available

**Image Upload:**
- Multiple images per listing (up to 8)
- Direct upload to S3
- Image preview before upload
- Reorder images (first image is main photo)
- Delete/replace images
- Automatic resize/compression (optional, future feature)

**Validation:**
- Required fields enforced
- Price must be positive number
- At least one image required
- Title character limits
- Description character limits

**Backend Processing:**
1. Validates all input data
2. Generates presigned S3 URLs
3. Frontend uploads images directly to S3
4. Creates Listing record in database
5. Stores S3 URLs in listing.images array
6. Returns listing ID to frontend
7. Navigates user to their new listing

#### Listing Display

**Feed/Home View:**
- Grid layout (responsive)
- Shows: Main image, title, price, location
- Infinite scroll pagination
- Sort options: Newest, Price (low-high), Price (high-low)
- Filter by category
- Quick favorite button

**Detail View:**
- Image carousel (swipe through photos)
- Full title and description
- All specifications displayed
- Condition ratings with visual indicators
- Price prominent
- Seller information card
- "Contact Seller" button (opens message)
- "Add to Favorites" button
- Related listings section (future feature)

**Seller's Own Listings:**
- "Edit" button visible
- "Delete" button visible
- View count displayed
- Favorite count displayed
- Mark as sold functionality

#### Listing Management
**Edit Listing:**
- Pre-populate form with existing data
- Allow changes to all fields except category
- Update images (add/remove/reorder)
- Save changes updates database record

**Delete Listing:**
- Confirmation dialog
- Soft delete (mark as "removed") vs hard delete (TBD)
- Images remain in S3 (cleanup strategy TBD)

**Mark as Sold:**
- Changes status to "sold"
- Removes from active listings feed
- Notifies favorited users (future feature)
- Still visible in seller's profile as "sold"

---

### Feature 2: Advanced Search & Filtering

#### Search Interface
**Quick Search:**
- Search bar present on every screen
- Searches: titles, descriptions, brands, models
- Real-time suggestions (future feature)
- Recent searches saved locally

**Advanced Search Screen:**
- All search filters in one place
- Category-specific filters appear dynamically
- Save search preferences (future feature)
- Search history (future feature)

#### Filter Options

**Universal Filters (all categories):**
- Keyword search
- Price range (min-max slider)
- Location (proximity search future feature)
- Condition (min condition rating)
- Date posted (last 24h, 7 days, 30 days, all time)
- Sort by: Newest, Price ascending, Price descending, Condition

**Category-Specific Filters:**

**Clubs:**
- Handedness (left/right/both)
- Shaft flex
- Shaft material
- Club length range
- Loft range (drivers/woods)
- Brand
- Model

**Golf Balls:**
- Brand
- Condition grade
- Quantity range

**Bags:**
- Bag type
- Stand type
- Number of dividers

**Accessories:**
- Accessory type
- Brand

#### Search Implementation
**Frontend:**
- Build query parameters from selected filters
- Send GET request to /api/search
- Display results in grid/list
- Show active filters with clear buttons
- "Clear all filters" option

**Backend:**
- Parse query parameters
- Build dynamic Prisma query
- Apply filters progressively
- Execute database query
- Return paginated results
- Include total count for pagination

**Performance Considerations:**
- Database indexes on frequently filtered fields
- Pagination (20 results per page)
- Lazy loading images
- Cache popular searches (future feature)

---

### Feature 3: Real-Time Messaging System

#### Architecture
**Technology:** Socket.io for websocket connections  
**Pattern:** Client-server real-time bidirectional communication

#### Messaging Flow

**Starting a Conversation:**
1. User views listing detail page
2. Clicks "Contact Seller" button
3. System checks: Does conversation already exist?
   - If yes: Open existing conversation
   - If no: Create new conversation
4. Opens message screen with conversation

**Sending a Message:**
1. User types message in input field
2. Presses send button
3. Frontend emits Socket.io event: 'new_message'
4. Backend receives event
5. Backend validates user authentication
6. Backend saves message to database
7. Backend broadcasts to conversation participants
8. Other user receives message in real-time
9. Message appears in sender's chat immediately

**Receiving a Message:**
1. User is in conversations list or active chat
2. Socket.io connection receives 'new_message' event
3. Message displays instantly
4. Unread count increments (if not in that conversation)
5. Notification created (if notifications enabled)
6. Conversation moves to top of list

**Real-Time Features:**
- Instant message delivery (no refresh needed)
- Typing indicators (shows when other person is typing)
- Read receipts (shows when message is read)
- Online status indicators (future feature)

#### Message Screen Components

**Conversations List:**
- All conversations sorted by most recent
- Shows: Other person's name, last message preview, timestamp
- Unread message count badge
- Tap to open conversation
- Swipe to delete (future feature)

**Conversation View:**
- Chat bubble interface
- Sender messages on right (blue)
- Receiver messages on left (gray)
- Timestamps
- Message input at bottom
- Scroll to load older messages (pagination)
- Pull to refresh

**Message Composition:**
- Text input field
- Send button
- Character counter (future feature)
- Image attachment button (future feature)
- Emoji picker (future feature)

#### Backend Socket.io Implementation

**Connection:**
```javascript
io.on('connection', (socket) => {
  // Client connects with auth token
  // Validate token
  // Store socket.id with user ID
  // Join user to their personal room
});
```

**Join Conversation:**
```javascript
socket.on('join_conversation', (conversationId) => {
  // Validate user is participant
  // Join socket to conversation room
  // Load message history
});
```

**Send Message:**
```javascript
socket.on('new_message', (data) => {
  // Validate sender
  // Save to database
  // Emit to conversation room
  // Create notification for receiver
  // Update conversation lastMessageAt
});
```

**Typing Indicator:**
```javascript
socket.on('typing', (conversationId) => {
  // Broadcast to other participant
  // Debounce to prevent spam
});
```

**Disconnection:**
```javascript
socket.on('disconnect', () => {
  // Remove socket.id from user mapping
  // Update online status
  // Clean up resources
});
```

#### Message Notifications
- Push notifications (future feature)
- In-app badge on Messages tab
- Unread count visible on conversations list
- Desktop notifications (web only, future feature)

---

### Feature 4: Favorites System

#### Purpose
Allow users to save listings they're interested in for later viewing.

#### User Flow
1. User sees listing (in feed or detail page)
2. Taps heart icon
3. Listing added to favorites
4. Heart icon fills in to show favorited state
5. Access all favorites from Favorites tab/screen

#### Favorites Screen
**Layout:**
- Grid view of favorited listings
- Same display as main feed
- Sort options: Date favorited, Price, Newest listings
- Remove from favorites button (un-heart)
- Empty state when no favorites

**Features:**
- Tap listing to view details
- Swipe to remove (mobile)
- Quick message seller button
- See if price changed since favoriting (future feature)

#### Backend Implementation
**Database:**
- Favorites table with userId + listingId
- Unique constraint (can't favorite twice)
- Timestamp when favorited

**API Endpoints:**
- POST /api/favorites/:listingId - Add to favorites
- DELETE /api/favorites/:listingId - Remove from favorites  
- GET /api/favorites - Get all user's favorites (with full listing data)

**Business Logic:**
- Increment favoriteCount on Listing when favorited
- Decrement favoriteCount when un-favorited
- Notify seller when listing is favorited (future feature)

---

### Feature 5: User Profiles & Seller Pages

#### Profile Types

**Own Profile (authenticated user viewing their profile):**
- Edit profile button
- All personal listings displayed
- Stats: Total listings, Active listings, Sold listings
- Edit profile information
- Logout button
- Settings access (future feature)

**Seller Profile (viewing another user's profile):**
- Profile picture (or default avatar)
- Username
- Member since date
- Bio/description
- Location (city/state)
- All active listings by this seller
- "Contact Seller" button
- Seller rating/reviews (future feature)

#### Profile Display

**Header Section:**
- Profile picture
- Username
- Join date
- Location
- Bio text
- Stats row (listings count, favorites count future)

**Listings Section:**
- Grid of all active listings
- Filter: Active / Sold / All
- Same display as main feed
- Tap to view listing details

**Actions:**
- Contact button (opens message)
- Follow seller (future feature)
- Report user (future feature)

#### Profile Editing

**Editable Fields:**
- Profile picture (upload to S3)
- Username (must be unique)
- First name
- Last name
- Bio (character limit)
- Location
- Phone number

**Validation:**
- Username uniqueness check
- Character limits enforced
- Image size limits
- Appropriate content checks (future feature)

**Backend:**
- PUT /api/users/profile
- Validate ownership (can only edit own profile)
- Update User record
- Return updated profile data

---

### Feature 6: Notifications System

#### Notification Types
1. **New Message** - Someone sent you a message
2. **Favorite Added** - Someone favorited your listing
3. **Price Change** - A favorited listing changed price (future feature)
4. **Listing Sold** - Your listing was marked as sold
5. **System Announcements** - Updates from platform

#### Notification Display

**In-App Notifications:**
- Notifications screen/tab
- List of all notifications
- Unread badge on tab icon
- Tap to navigate to relevant screen
- Mark as read action
- Delete notification action
- Clear all read notifications

**Notification Structure:**
- Icon (based on type)
- Title
- Message text
- Timestamp (relative: "5m ago", "2h ago")
- Related entity link (listing, message, etc.)
- Read/unread indicator

**Push Notifications (Future Feature):**
- iOS and Android push notifications
- Configurable in settings
- Notification preferences by type

#### Backend Implementation
**Database:**
- Notifications table
- Type, userId, content, relatedId, isRead, createdAt

**Creation Triggers:**
- New message → Create notification for receiver
- Listing favorited → Create notification for seller
- Listing sold → Create notification for favorited users

**API Endpoints:**
- GET /api/notifications - Get all user notifications
- PUT /api/notifications/:id/read - Mark as read
- DELETE /api/notifications/:id - Delete notification
- PUT /api/notifications/read-all - Mark all as read

---

## 10. API ENDPOINTS REFERENCE

### Authentication Endpoints
```
POST /api/auth/register
Body: { email, password, username, firstName, lastName }
Response: { user, tokens }

POST /api/auth/login
Body: { email, password }
Response: { user, tokens }

POST /api/auth/logout
Headers: Authorization: Bearer {token}
Response: { success }

GET /api/auth/verify
Headers: Authorization: Bearer {token}
Response: { valid, user }

POST /api/auth/refresh
Body: { refreshToken }
Response: { accessToken }
```

### Listings Endpoints
```
POST /api/listings
Headers: Authorization: Bearer {token}
Body: { title, description, category, specifications, price, images }
Response: { listing }

GET /api/listings
Query: ?page=1&limit=20&category=drivers&sort=newest
Response: { listings[], totalCount, page, totalPages }

GET /api/listings/:id
Response: { listing }

PUT /api/listings/:id
Headers: Authorization: Bearer {token}
Body: { fields to update }
Response: { listing }

DELETE /api/listings/:id
Headers: Authorization: Bearer {token}
Response: { success }

POST /api/listings/upload-images
Headers: Authorization: Bearer {token}
Body: { images[] }
Response: { imageUrls[] }
```

### Search Endpoints
```
GET /api/search
Query: ?keyword=titleist&category=drivers&minPrice=100&maxPrice=500&flex=stiff&handedness=right&sort=price_asc
Response: { results[], totalCount, filters }

POST /api/search/filters
Body: { category }
Response: { availableFilters }
```

### Messages Endpoints
```
GET /api/messages/conversations
Headers: Authorization: Bearer {token}
Response: { conversations[] }

GET /api/messages/:conversationId
Headers: Authorization: Bearer {token}
Query: ?page=1&limit=50
Response: { messages[], conversation }

POST /api/messages
Headers: Authorization: Bearer {token}
Body: { conversationId, content, listingId }
Response: { message }
Also emits Socket.io event to participants

PUT /api/messages/:messageId/read
Headers: Authorization: Bearer {token}
Response: { success }
```

### Favorites Endpoints
```
POST /api/favorites/:listingId
Headers: Authorization: Bearer {token}
Response: { favorite }

DELETE /api/favorites/:listingId
Headers: Authorization: Bearer {token}
Response: { success }

GET /api/favorites
Headers: Authorization: Bearer {token}
Response: { favorites[] with listing data }
```

### User/Profile Endpoints
```
GET /api/users/:userId
Response: { user public profile }

GET /api/users/:userId/listings
Query: ?status=active
Response: { listings[] }

PUT /api/users/profile
Headers: Authorization: Bearer {token}
Body: { fields to update }
Response: { user }

GET /api/users/me
Headers: Authorization: Bearer {token}
Response: { user full profile }
```

### Notifications Endpoints
```
GET /api/notifications
Headers: Authorization: Bearer {token}
Query: ?unread=true
Response: { notifications[] }

PUT /api/notifications/:id/read
Headers: Authorization: Bearer {token}
Response: { notification }

DELETE /api/notifications/:id
Headers: Authorization: Bearer {token}
Response: { success }

PUT /api/notifications/read-all
Headers: Authorization: Bearer {token}
Response: { count }
```

### Socket.io Events
```
Client Emits:
- 'join_conversation' - Join a conversation room
- 'new_message' - Send a new message
- 'typing' - Indicate typing status
- 'leave_conversation' - Leave a conversation room

Server Emits:
- 'message_received' - New message in conversation
- 'message_read' - Message was read
- 'user_typing' - Other user is typing
- 'conversation_updated' - Conversation metadata changed
```

---

## 11. KNOWN ISSUES & RESOLUTIONS

### Issue 1: Cognito ID vs Database ID (RESOLVED)

**Problem:**
- Backend was using AWS Cognito IDs for all database operations
- Should have been using PostgreSQL user IDs
- Caused incorrect data associations
- Messages, listings, favorites linked to wrong users

**Symptoms:**
- User couldn't see their own listings
- Messages went to wrong conversations
- Favorites not appearing correctly

**Root Cause:**
- Confusion between authentication identity (Cognito ID) and application identity (database user ID)
- Mixed use of both IDs throughout backend code

**Resolution:**
1. Standardized on database user ID for all operations
2. Cognito ID used ONLY for authentication lookup
3. Updated all API endpoints to use database ID
4. Fixed foreign key relationships
5. Migrated existing data to correct associations

**Verification:**
- All CRUD operations tested
- Authentication flow verified
- Data associations confirmed correct
- Issue fully resolved

---

### Issue 2: S3 Image Permissions (RESOLVED)

**Problem:**
- Images uploaded successfully to S3
- Images not displaying in application
- "Access Denied" errors when loading images

**Symptoms:**
- Broken image icons
- Console errors about CORS
- 403 Forbidden responses from S3

**Root Cause:**
- Bucket policy too restrictive
- CORS configuration missing
- Presigned URL generation incorrect

**Resolution:**
1. Updated S3 bucket policy for public read access
2. Configured CORS rules properly:
   ```json
   {
     "AllowedOrigins": ["*"],
     "AllowedMethods": ["GET", "POST"],
     "AllowedHeaders": ["*"]
   }
   ```
3. Fixed presigned URL generation in backend
4. Set appropriate expiration times for URLs

**Verification:**
- Images display correctly in web app
- Images display correctly in mobile app
- Upload functionality working
- Issue fully resolved

---

### Issue 3: Duplicate AWS Infrastructure in Stockholm (RESOLVED)

**Problem:**
- Unexpected AWS bill of $170/month
- All development was supposed to be in London region
- Discovered duplicate infrastructure in Stockholm (eu-north-1)

**Cause:**
- Accidentally created resources in Stockholm region
- Didn't notice region setting during resource creation
- Resources left running and accumulating costs

**Discovery:**
- Reviewed AWS billing dashboard
- Checked each service by region
- Found complete duplicate stack in Stockholm

**Resolution Process:**
1. **Verified London environment still intact**
2. **Systematically deleted Stockholm resources:**
   - Terminated EC2 instances
   - Deleted RDS database instances
   - Removed S3 buckets
   - Deleted Cognito user pools
   - Removed security groups and VPCs
   - Deleted IAM roles specific to Stockholm
3. **Set up billing alerts** to catch future issues
4. **Documented correct region** (London only)

**Cost Impact:**
- $170/month eliminated
- Back to free tier
- Ongoing monthly cost: $0-5

**Prevention:**
- Always verify region before creating resources
- Use billing alerts
- Regular cost audits
- Strict "London only" policy

**Status:** Fully resolved, no more Stockholm resources

---

### Issue 4: Import Path Errors in React Native Translation (IN PROGRESS)

**Problem:**
- Next.js and React Native have different module systems
- Import paths that worked in web don't work in mobile
- Getting "module not found" errors
- Dependency conflicts between Next.js libraries and React Native equivalents

**Symptoms:**
- App won't build or crashes on start
- Import errors in multiple files
- Components not rendering

**Examples of Issues:**
```javascript
// Next.js (works)
import Image from 'next/image'
import { useRouter } from 'next/router'

// React Native (needs translation)
import { Image } from 'react-native'
import { useRouter } from 'expo-router'
```

**Current Resolution Approach:**
1. Identify each Next.js-specific import
2. Find React Native equivalent
3. Update import statements systematically
4. Test each screen after updates
5. Fix related dependency issues

**Common Translations Needed:**
- `next/image` → `react-native` Image or `expo-image`
- `next/router` → `expo-router`
- `next/link` → `expo-router` Link
- Next.js specific components → React Native components

**Status:** Actively debugging, fixing file by file

---

### Issue 5: Authentication Context in React Native (IN PROGRESS)

**Problem:**
- Authentication context from web app not working in mobile
- Different async storage implementation
- Context not persisting across app restarts
- Token refresh flow different

**Resolution Approach:**
1. Rebuild authentication context for React Native
2. Use AsyncStorage for token storage
3. Implement proper context provider
4. Add token refresh logic
5. Handle session persistence

**Status:** Currently implementing fix

---

## 12. DEVELOPMENT HISTORY TIMELINE

### Phase 1: Foundation & Learning (Early Months)

**Week 1-2: Environment Setup**
- Installed development tools (Node.js, VS Code, Git)
- Created AWS account
- Set up basic React development environment
- Learned fundamental programming concepts

**Week 3-4: Learning Full-Stack Basics**
- Learned JavaScript fundamentals
- Studied React basics
- Understood client-server architecture
- Researched marketplace platforms

**Week 5-6: Technology Stack Selection**
- Chose Next.js for web frontend
- Selected Node.js + Express for backend
- Decided on PostgreSQL database
- Researched AWS services

### Phase 2: Backend Development (Months 2-3)

**AWS Infrastructure Setup:**
- Created AWS account and configured billing alerts
- Set up RDS PostgreSQL database in London region
- Configured S3 bucket for images
- Set up Cognito user pool
- Launched EC2 instance for backend

**Backend API Development:**
- Built Express.js server structure
- Integrated Prisma ORM
- Created database schema
- Implemented authentication with Cognito
- Built listings CRUD endpoints
- Added image upload to S3
- Developed search API with filters

**Socket.io Integration:**
- Added Socket.io for real-time messaging
- Built conversation system
- Implemented message delivery
- Added typing indicators

### Phase 3: Web Frontend Development (Months 3-4)

**Initial Setup:**
- Created Next.js project
- Set up TypeScript configuration
- Designed component structure
- Planned page architecture

**Core Pages Built:**
1. Login & Registration pages
2. Home feed with listings grid
3. Search page with filters
4. Listing detail page with image carousel
5. Create listing page with dynamic forms
6. Messages interface
7. Favorites page
8. User profile pages
9. Seller profile pages

**Feature Implementation:**
- Authentication flow with Cognito integration
- Image uploads and display
- Real-time messaging UI
- Search and filter functionality
- Favorites system
- Notifications display

### Phase 4: Golf-Specific Features (Month 4-5)

**Equipment Specifications:**
- Researched golf equipment categories
- Defined category-specific attributes
- Built dynamic form system
- Implemented condition rating components
- Organized brands by popularity
- Created component condition rating (club head, shaft, grip)

**Search Enhancement:**
- Added golf-specific filters
- Category-based filter display
- Advanced search combinations
- Sort and pagination

### Phase 5: Critical Bug Fixes (Month 5)

**The Cognito ID Issue:**
- Discovered data association problems
- Identified root cause (using Cognito IDs instead of database IDs)
- Systematic fix across entire backend
- Data migration for existing records
- Thorough testing and verification

**S3 Permissions:**
- Debugged image display issues
- Fixed bucket policies
- Configured CORS properly
- Implemented presigned URLs correctly

**The Stockholm Cost Incident:**
- Discovered $170/month charges
- Investigated and found duplicate infrastructure
- Systematically deleted Stockholm resources
- Preserved London environment
- Set up better cost monitoring

### Phase 6: Web App Completion & Polish (Month 6)

**Feature Completion:**
- All 9 core pages fully functional
- End-to-end testing
- Bug fixes and refinements
- User experience improvements

**Consultation with Advisor:**
- Discussed mobile-first strategy
- Decided to build mobile app for app stores
- Chose React Native with Expo
- Planned systematic translation approach

**Decision to Build Mobile App:**
- Mobile is where users will be
- App store presence important
- Native mobile experience better for marketplace
- Keep web app for desktop users

### Phase 7: Mobile App Translation (Current - Month 7+)

**React Native Setup:**
- Installed Expo CLI
- Created new Expo project with Router
- Set up TypeScript configuration
- Planned screen structure matching web app

**Current Work:**
- Translating screens one by one
- Converting Next.js imports to React Native
- Rebuilding authentication context
- Fixing dependency conflicts
- Testing on iOS and Android

**Challenges Being Addressed:**
- Import path differences
- Component library differences
- Navigation system differences
- Storage implementation differences
- Platform-specific styling

### Current Status
**Completed:**
- ✅ Full backend API (all 4 systems)
- ✅ Complete web application (9 pages)
- ✅ AWS infrastructure (properly configured)
- ✅ Golf equipment specifications
- ✅ Real-time messaging
- ✅ Search and filtering
- ✅ Favorites system
- ✅ User profiles
- ✅ Notifications

**In Progress:**
- 🔄 React Native mobile app translation
- 🔄 Mobile authentication context
- 🔄 Import path fixes
- 🔄 Mobile testing

**Next Steps:**
- Complete mobile app translation
- Test on real devices
- App store submission preparation
- Beta testing
- Launch

---

## 13. COST MANAGEMENT & AWS FREE TIER

### Free Tier Limits (12 Months)

**EC2:**
- 750 hours/month of t2.micro or t3.micro
- Strategy: Stop instance when not developing
- Actual usage: ~100-200 hours/month
- Status: Well within limit

**RDS:**
- 750 hours/month of db.t2.micro or db.t3.micro
- 20GB storage
- Strategy: Single instance, minimal backups
- Actual usage: ~15GB storage, running continuously
- Status: Within limit

**S3:**
- 5GB storage
- 20,000 GET requests
- 2,000 PUT requests
- Strategy: Optimize image sizes, clean up unused images
- Actual usage: ~2-3GB
- Status: Within limit

**Cognito:**
- 50,000 Monthly Active Users (MAU)
- Strategy: MVP launch won't hit this
- Actual usage: Development testing only (~5 users)
- Status: Well within limit

**Data Transfer:**
- 15GB out per month
- Strategy: Minimize unnecessary data transfer
- Actual usage: Minimal during development
- Status: Within limit

### Cost Monitoring Strategy

**Weekly Checks:**
- Review AWS billing dashboard
- Check cost by service
- Verify region (London only)
- Review unexpected charges

**Billing Alerts:**
- Alert at $10
- Alert at $20
- Email notifications enabled

**Monthly Budget:**
- Target: $0 (stay in free tier)
- Acceptable: $0-5 for occasional overages
- Maximum: $10 before investigation

### Cost-Saving Practices

**Development Workflow:**
1. Plan coding session
2. Start EC2 instance
3. Develop/test for focused period
4. Stop EC2 instance when done
5. RDS runs continuously (needed for persistence)

**Storage Management:**
- Regular S3 cleanup of test images
- Delete unused listing images
- Compress images before upload
- Monitor storage growth

**Database Management:**
- Minimal backup retention (7 days)
- No Multi-AZ deployment
- Regular data cleanup (test data)
- Efficient queries to reduce load

### Historical Cost Issues & Resolutions

**Stockholm Incident (Resolved):**
- Cost: $170/month
- Duration: ~2 months before discovery
- Total wasted: ~$340
- Resolution: Deleted all Stockholm resources
- Current status: $0 Stockholm costs

**Lessons Learned:**
1. Always verify region before creating resources
2. Set up billing alerts immediately
3. Regular cost audits essential
4. Document intended architecture
5. Be vigilant about duplicate resources

### Current Cost Status
**Monthly Costs:** $0-2 (within free tier)  
**Services in Use:** EC2, RDS, S3, Cognito (all free tier)  
**Next Free Tier Expiration:** [Date when 12 months ends]  
**Post-Free Tier Plan:** Evaluate costs, optimize or migrate to cheaper solutions

---

## 14. DEVELOPER PREFERENCES & WORKFLOW

### Learning Style & Communication

**Experience Level:**
- Absolute beginner at start of project
- No prior programming experience
- Learning full-stack development during project
- Methodical, step-by-step approach essential

**Preferred Communication Style:**
- Detailed explanations needed
- Step-by-step instructions preferred
- Complete code examples rather than snippets
- Clear reasoning for technical decisions
- Reassurance about data safety and security

**Code Preferences:**
- Complete file rewrites preferred over partial fixes
- Full context better than isolated changes
- Explicit imports and dependencies
- Comments explaining complex logic
- Consistent code style throughout

### Development Workflow

**Typical Development Session:**
1. Plan what to build/fix
2. Start AWS EC2 instance
3. Research and understand the feature
4. Write code with AI assistance
5. Test functionality
6. Debug issues systematically
7. Verify everything works
8. Stop EC2 instance
9. Document changes

**Problem-Solving Approach:**
- Break complex problems into smaller steps
- Understand the "why" before implementing
- Test each component separately
- Systematic debugging when issues arise
- Don't rush, ensure proper understanding

**Quality Standards:**
- Working functionality is priority
- Security considerations important
- Cost management always in mind
- User experience matters
- Code organization and structure

### AI Assistance Preferences

**When Asking for Help:**
- Provide full context about the issue
- Share relevant code completely
- Explain what was already tried
- Ask for step-by-step guidance
- Request complete solutions rather than hints

**Preferred Response Format:**
- Explanation of what needs to be done
- Complete code with all imports
- Explanation of how it works
- What to test to verify it works
- Potential issues to watch for

**Areas Needing Extra Guidance:**
- Complex programming concepts
- AWS service configurations
- Database relationships
- Authentication flows
- Debugging strategies

### Project Management

**Decision-Making:**
- Consult with software developer advisor for major decisions
- Research options thoroughly before choosing
- Consider cost implications
- Think about scalability (but focus on MVP first)
- Balance best practices with learning curve

**Scope Management:**
- Stick to defined MVP scope
- Don't add features until core is solid
- Document "nice to have" features for later
- Focus on launching rather than perfecting

**Documentation:**
- Document important decisions
- Keep track of resolved issues
- Note configuration details
- Save working code examples
- Record lessons learned

### Security Mindset

**Data Safety Concerns:**
- Frequent questions about data security
- Wants reassurance about user data protection
- Careful about AWS credentials
- Concerned about cost overruns
- Cautious about making breaking changes

**Best Practices Followed:**
- Never commit credentials to Git
- Use environment variables for sensitive data
- Regular backups before major changes
- Test authentication thoroughly
- Validate user inputs

---

## 15. NEXT STEPS & FUTURE PLANS

### Immediate Priorities (Current Sprint)

**Complete Mobile App Translation:**
1. Fix remaining import path issues
2. Resolve authentication context for mobile
3. Test all 9 screens thoroughly
4. Ensure feature parity with web app
5. Fix any mobile-specific bugs

**Testing Phase:**
1. Test on iOS simulator
2. Test on Android emulator
3. Test on real iOS device
4. Test on real Android device
5. End-to-end testing of all features

### Pre-Launch Preparation

**App Store Requirements:**
1. **iOS (Apple App Store):**
   - Apple Developer account ($99/year)
   - App icons in all required sizes
   - Screenshots for different devices
   - App description and marketing text
   - Privacy policy
   - Terms of service
   - App review preparation

2. **Android (Google Play Store):**
   - Google Play Developer account ($25 one-time)
   - App icons and feature graphic
   - Screenshots for different devices
   - Store listing content
   - Privacy policy
   - Terms of service
   - App review preparation

**Legal Requirements:**
- Privacy policy (GDPR compliant if EU users)
- Terms of service
- Cookie policy (web app)
- User data handling documentation
- Payment processing terms (future, when added)

**Backend Hardening:**
- Move from development to production environment
- Environment variable configuration for production
- SSL/HTTPS certificates
- Database backup strategy
- Error logging and monitoring
- Rate limiting for API endpoints
- Security audit

### Launch Strategy (Post-Mobile App Completion)

**Soft Launch:**
1. Beta test with small group (10-20 users)
2. Gather feedback
3. Fix critical issues
4. Monitor performance and costs

**Official Launch:**
1. Submit to app stores (1-2 week approval process)
2. Launch web app publicly
3. Announce to golf communities
4. Social media presence
5. Initial marketing push

**Early Metrics to Track:**
- User signups
- Listings created
- Messages sent
- Favorite actions
- User retention
- Bug reports
- AWS costs

### Post-Launch Features (Deferred from MVP)

**Payment Integration:**
- Stripe or similar payment processor
- Secure checkout flow
- Transaction fees (business model)
- Payout system for sellers
- Refund handling

**Enhanced Features:**
1. **Social Features:**
   - Follow sellers
   - Seller ratings and reviews
   - User reputation system
   - Share listings to social media

2. **Marketplace Enhancements:**
   - Promoted listings (paid feature)
   - Featured sellers
   - Listing expiration and renewal
   - Make offer / negotiate price
   - Saved searches with alerts
   - Price drop notifications

3. **Communication:**
   - Video calls for item inspection (maybe)
   - Image sharing in messages
   - Location sharing for meetups
   - In-app notifications push

4. **Discovery:**
   - Recommendation engine
   - Similar listings suggestions
   - Recently viewed items
   - Trending equipment
   - Seasonal recommendations

5. **Trust & Safety:**
   - Identity verification
   - Seller verification badges
   - Report listing/user
   - Dispute resolution
   - Insurance options

6. **Analytics:**
   - Seller dashboard with stats
   - Market price insights
   - Listing performance metrics
   - User engagement analytics

### Scaling Considerations (When Needed)

**Performance:**
- Database optimization and indexing
- CDN for image delivery
- Redis for caching
- Load balancing for backend
- Database read replicas

**Cost Management Post-Free Tier:**
- Optimize AWS costs
- Consider alternative hosting (DigitalOcean, Heroku)
- CDN for static assets (CloudFlare)
- Efficient database queries
- Image compression and optimization

**Monitoring:**
- Application performance monitoring (APM)
- Error tracking (Sentry or similar)
- User analytics (Mixpanel, Amplitude)
- Server monitoring
- Cost alerts and optimization

### Investment/Funding Strategy

**Initial Validation:**
- Launch with MVP
- Prove product-market fit
- Gather user data and metrics
- Build initial user base

**Metrics for Investors:**
- Monthly Active Users (MAU)
- Listings created per month
- Messages sent (engagement)
- Transaction volume (when payments added)
- User retention rates
- Growth rate
- Revenue potential

**Funding Approach:**
- Bootstrap initially (free tier)
- Seek investment after proving traction
- Pitch deck highlighting golf market opportunity
- Demonstrate user engagement
- Show path to monetization
- Market analysis and competition

### Long-Term Vision

**Product Evolution:**
- Leading golf equipment marketplace
- Community hub for golfers
- Content and education
- Event listings and tournaments
- Course reviews and recommendations
- Golf travel and experiences

**Business Model:**
- Transaction fees on sales
- Premium seller subscriptions
- Featured listings
- Advertising opportunities
- Partnerships with golf brands
- Data insights for industry

**Geographic Expansion:**
- Start locally/regionally
- Expand to national coverage
- International markets (UK, Europe, Asia)
- Localization and currency support
- Shipping and logistics partnerships

---

## APPENDIX: QUICK REFERENCE

### Key URLs & Endpoints
- **Backend API:** http://192.168.1.214:3000
- **API Base:** http://192.168.1.214:3000/api
- **Socket.io:** ws://192.168.1.214:3000

### Critical Files & Directories

**Backend:**
```
/backend
  ├── /src
  │   ├── /routes (API endpoints)
  │   ├── /controllers (business logic)
  │   ├── /models (Prisma models)
  │   ├── /middleware (auth, validation)
  │   ├── /services (S3, Cognito integrations)
  │   └── server.ts (main entry point)
  ├── /prisma
  │   └── schema.prisma (database schema)
  └── package.json
```

**Web App:**
```
/web
  ├── /pages (Next.js pages)
  ├── /components (React components)
  ├── /contexts (Auth, etc.)
  ├── /lib (utilities)
  ├── /styles (CSS)
  └── package.json
```

**Mobile App:**
```
/mobile
  ├── /app (Expo Router file-based routing)
  │   ├── (tabs) (tab navigation screens)
  │   ├── /listing (listing detail)
  │   └── /create (create listing)
  ├── /components (React Native components)
  ├── /contexts (Auth context)
  ├── /lib (utilities)
  └── package.json
```

### Important Commands

**Backend:**
```bash
npm run dev          # Start development server
npm run build        # Build for production
npm start            # Start production server
npx prisma migrate   # Run database migrations
npx prisma studio    # Open database GUI
```

**Web App:**
```bash
npm run dev          # Start Next.js dev server
npm run build        # Build for production
npm start            # Start production server
```

**Mobile App:**
```bash
npx expo start       # Start Expo development server
npx expo start --ios # Start iOS simulator
npx expo start --android # Start Android emulator
npm run build        # Build for production
```

**AWS Commands:**
```bash
# EC2
aws ec2 start-instances --instance-ids i-xxxxx
aws ec2 stop-instances --instance-ids i-xxxxx

# S3
aws s3 ls s3://bucket-name
aws s3 cp file.jpg s3://bucket-name/path/
```

### Environment Variables Needed

**Backend (.env):**
```
DATABASE_URL=postgresql://user:pass@host:5432/db
AWS_REGION=eu-west-2
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx
S3_BUCKET_NAME=mulligans-listings
COGNITO_USER_POOL_ID=xxx
COGNITO_CLIENT_ID=xxx
JWT_SECRET=xxx
NODE_ENV=development
```

**Frontend (web and mobile):**
```
NEXT_PUBLIC_API_URL=http://192.168.1.214:3000
NEXT_PUBLIC_SOCKET_URL=ws://192.168.1.214:3000
```

### Common Debugging Steps

**Backend not responding:**
1. Check if EC2 instance is running
2. Check security group allows port 3000
3. Check backend logs for errors
4. Verify environment variables set
5. Check database connection

**Authentication not working:**
1. Verify Cognito configuration
2. Check tokens are being sent in headers
3. Verify backend is using database user IDs
4. Check user exists in both Cognito and PostgreSQL
5. Review authentication context implementation

**Images not loading:**
1. Check S3 bucket exists and is in correct region
2. Verify bucket policy allows public read
3. Check CORS configuration
4. Verify presigned URLs are being generated
5. Check image URLs in database

**Mobile app won't build:**
1. Check for import path errors
2. Verify all dependencies installed
3. Clear Metro bundler cache: `npx expo start -c`
4. Check for TypeScript errors
5. Verify Expo SDK version compatibility

---

## CONCLUSION

This document represents the complete state of the Mulligans MVP project as of [Current Date]. It encompasses:

- **Technical Architecture:** Full-stack marketplace with React Native mobile app, Next.js web app, Node.js backend, PostgreSQL database, and AWS infrastructure
- **Development Journey:** From absolute beginner to functional full-stack application
- **Current Status:** Completed web app, mobile app in final debugging phase
- **Business Goal:** Launch MVP, validate market, seek investment

**Next Major Milestone:** Complete mobile app and launch to app stores

**For AI Assistants (like Cursor):**
This document provides complete context about the project. Reference specific sections when helping with:
- Bug fixes (see Known Issues section)
- Feature implementation (see Core Features section)
- AWS infrastructure (see AWS Infrastructure section)
- API development (see API Endpoints section)
- Database queries (see Database Schema section)

**For the Developer:**
Use this as a reference when:
- Explaining the project to others
- Remembering how something was implemented
- Planning future features
- Debugging issues
- Making architectural decisions

---

**Last Updated:** [Date]  
**Version:** 1.0  
**Status:** Complete web app, mobile app in progress  
**Developer:** Mr. Mulligans (Solo)  
**Project Duration:** ~7 months to current state