// src/controllers/listingController.ts
import { Response } from 'express';
import { prisma } from '../lib/prisma';
import { PRIMARY_IMAGE_ORDER } from '../lib/imageOrder';
import { AuthenticatedRequest } from '../middleware/auth';
import { S3Service } from '../services/s3Service';


// ✅ SIZE VARIANT: Helper to calculate total quantity from size quantities
function calculateTotalFromSizeQuantities(specifications: any): number | null {
  if (!specifications?.sizeQuantities || typeof specifications.sizeQuantities !== 'object') {
    return null;
  }
  const total = Object.values(specifications.sizeQuantities).reduce(
    (sum: number, qty: any) => sum + (parseInt(qty) || 0), 
    0
  );
  return total > 0 ? total : null;
}

export class ListingController {
  /**
   * Get featured listings with personalization for home screen
   * Prioritizes items matching user's size preferences
   */
  static async getFeaturedListings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      let userPreferences = null;

      console.log('🏠 GET /listings/featured - User ID:', userId || 'Guest');

      // If user is logged in, get their preferences
      if (userId) {
        userPreferences = await prisma.users.findUnique({
          where: { id: userId },
          select: {
            sizing_preference: true,
            clothing_size: true,
            shoe_size: true,
            glove_size: true,
          },
        });
        
        if (userPreferences) {
          console.log('👤 User preferences:', {
            sizing: userPreferences.sizing_preference,
            clothing_sizes: userPreferences.clothing_size.length,
            shoe_sizes: userPreferences.shoe_size.length,
            glove_sizes: userPreferences.glove_size.length,
          });
        }
      }

      // Get featured/recent active listings (limit to 20 for home screen)
      const allListings = await prisma.listings.findMany({
  where: {
    status: 'active',
    users: {
      is_pro_store: true,
    },
  },
  include: {
          images: {
            orderBy: PRIMARY_IMAGE_ORDER,
            take: 1,
          },
         users: {
            select: {
              id: true,
              display_name: true,
              rating: true,
              is_verified_seller: true,
              is_pro_store: true,
              pro_store_name: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
        take: 30,
      });

      console.log(`📦 Found ${allListings.length} active listings`);

      // If user has size preferences, prioritize matching items
      if (
        userPreferences &&
        (userPreferences.clothing_size.length > 0 ||
          userPreferences.shoe_size.length > 0 ||
          userPreferences.glove_size.length > 0)
      ) {
        const matchingListings: any[] = [];
        const nonMatchingListings: any[] = [];

        allListings.forEach((listing) => {
          let matches = false;

          // Check specifications JSON for size information
          if (listing.specifications) {
            const specs = listing.specifications as any;
            
            // Check clothing size
            if (specs.clothing_size && userPreferences.clothing_size.includes(specs.clothing_size)) {
              matches = true;
            }
            
            // Check shoe size
            if (specs.shoe_size && userPreferences.shoe_size.includes(specs.shoe_size)) {
              matches = true;
            }
            
            // Check glove size
            if (specs.glove_size && userPreferences.glove_size.includes(specs.glove_size)) {
              matches = true;
            }
          }

          if (matches) {
            matchingListings.push(listing);
          } else {
            nonMatchingListings.push(listing);
          }
        });

        console.log(`✨ Personalized: ${matchingListings.length} matching, ${nonMatchingListings.length} other`);

        // Return matching items first, then others
        res.json({
          listings: [...matchingListings, ...nonMatchingListings],
          total: allListings.length,
          personalized: matchingListings.length > 0,
          matches: matchingListings.length,
        });
        return;
      }

      // No preferences or not logged in - return all listings normally
      console.log('📋 Returning unpersonalized listings');
      res.json({
        listings: allListings,
        total: allListings.length,
        personalized: false,
        matches: 0,
      });
    } catch (error) {
      console.error('❌ Get featured listings error:', error);
      res.status(500).json({ error: 'Failed to get featured listings' });
    }
  }

  /**
   * Create a new listing
   */
  static async createListing(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Get user ID directly from JWT - it's already verified by middleware
      const userId = req.user!.id;
      console.log('🔍 User ID from JWT:', userId);

      if (!userId) {
        res.status(401).json({ error: 'User ID not found in token' });
        return;
      }

      const {
        title,
        description,
        price,
        category,
        subcategory,
        brand,
        model,
        condition,
        condition_overall,
        condition_head,
        condition_shaft,
        condition_grip,
        ball_condition_type,
        specifications,
        location,
        is_negotiable,
        parcel_size,
        shipping_cost,
        quantity,
        status,
      } = req.body;

      // Verify user exists (optional safety check)
      const user = await prisma.users.findUnique({
        where: { id: userId }
      });

      console.log('🔍 User found in database:', user);

      if (!user) {
        res.status(404).json({ error: 'User not found in database' });
        return;
      }

      // ✅ Calculate average condition for clubs
      let finalConditionOverall = condition_overall;
      
      if (category === 'Clubs' && condition_head && condition_shaft && condition_grip) {
        // Average the 3 ratings and round to nearest integer
        finalConditionOverall = Math.round(
          (parseInt(condition_head) + parseInt(condition_shaft) + parseInt(condition_grip)) / 3
        );
        console.log(`📊 Club condition calculated: Head(${condition_head}) + Shaft(${condition_shaft}) + Grip(${condition_grip}) = Overall(${finalConditionOverall})`);
      }

      // Create the listing
      const listing = await prisma.listings.create({
        data: {
          id: `lst_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          title,
          description,
          price: parseFloat(price),
          category,
          subcategory: subcategory || null,
          brand: brand || null,
          model: model || null,
          condition_overall: finalConditionOverall || null,
          condition_head: condition_head || null,
          condition_shaft: condition_shaft || null,
          condition_grip: condition_grip || null,
          ball_condition_type: ball_condition_type || null,
          specifications: specifications || null,
          location: location || 'UK',
          is_negotiable: is_negotiable || false,
          parcel_size: parcel_size || null,
          shipping_cost: shipping_cost ? parseFloat(shipping_cost) : null,
          // ✅ SIZE VARIANT: Auto-calculate quantity from sizeQuantities if present
          quantity: calculateTotalFromSizeQuantities(specifications) || (quantity ? parseInt(quantity) : 1),
          seller_id: userId,
          status: status ?? 'active',
          created_at: new Date(),
          updated_at: new Date(),
        },
      });

      console.log('✅ Listing created:', listing.id, 'with shipping:', parcel_size, '£' + shipping_cost, 'quantity:', quantity || 1);

      // ✅ Save specifications to listing_attributes for filtering
      if (specifications && typeof specifications === 'object') {
        const attributeRecords: any[] = [];
        
        Object.entries(specifications).forEach(([key, value]) => {
          // Special handling for setMakeup array - create separate record for each iron
          if (key === 'setMakeup' && Array.isArray(value)) {
            value.forEach((iron: string) => {
              attributeRecords.push({
                id: `attr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                listing_id: listing.id,
                key: 'setMakeup',
                value: iron, // Store each iron separately: "3", "4", "5", etc.
                created_at: new Date(),
              });
            });
          } else {
            // Regular attributes
            attributeRecords.push({
              id: `attr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              listing_id: listing.id,
              key: key,
              value: typeof value === 'string' ? value : JSON.stringify(value),
              created_at: new Date(),
            });
          }
        });

        if (attributeRecords.length > 0) {
          await prisma.listing_attributes.createMany({
            data: attributeRecords,
          });
          console.log(`✅ Saved ${attributeRecords.length} attributes to listing_attributes`);
        }
      }

      // Fetch the complete listing with images (if any)
      const completeListingData = await prisma.listings.findUnique({
        where: { id: listing.id },
        include: {
          images: {
            orderBy: PRIMARY_IMAGE_ORDER,
          }
        },
      });

      // Get seller info separately
      const seller = await prisma.users.findUnique({
        where: { id: user.id },
        select: {
          id: true,
          display_name: true,
          avatar_url: true,
          rating: true,
        }
      });

      res.status(201).json({ listing: { ...completeListingData, seller } });
    } catch (error) {
      console.error('Create listing error:', error);
      res.status(500).json({ error: 'Failed to create listing' });
    }
  }

  /**
   * Upload listing images
   */
  static async uploadListingImage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user!.id;

      // Verify listing exists and belongs to user
      const listing = await prisma.listings.findUnique({
        where: { id },
      });

      if (!listing) {
        res.status(404).json({ error: 'Listing not found' });
        return;
      }

      // Verify user owns the listing
      if (listing.seller_id !== userId) {
        res.status(403).json({ error: 'Unauthorized' });
        return;
      }

      const files = req.files as Express.Multer.File[];

      if (!files || files.length === 0) {
        res.status(400).json({ error: 'No files uploaded' });
        return;
      }

      console.log(`📸 Uploading ${files.length} images...`);

      // Import sharp for image processing
      const sharp = require('sharp');

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        // Process image: convert to JPG, resize if needed, compress
        let processedBuffer = file.buffer;
        let finalFilename = file.originalname;

        try {
          console.log(`🔄 Processing image ${i + 1}: ${file.originalname} (${file.mimetype})`);
          
          // Convert HEIC/HEIF to JPG, and optimize all images
          processedBuffer = await sharp(file.buffer)
            .rotate() // Auto-rotate based on EXIF
            .resize(2000, 2000, { // Max dimensions, maintains aspect ratio
              fit: 'inside',
              withoutEnlargement: true // Don't upscale small images
            })
            .jpeg({ // Convert to JPG
              quality: 85, // Good quality, reasonable file size
              progressive: true // Progressive loading
            })
            .toBuffer();

          // Change extension to .jpg
          finalFilename = file.originalname.replace(/\.(heic|heif|png|webp)$/i, '.jpg');
          if (!finalFilename.toLowerCase().endsWith('.jpg')) {
            finalFilename += '.jpg';
          }

          console.log(`✅ Image processed: ${file.originalname} → ${finalFilename}`);
        } catch (processError) {
          console.error(`⚠️ Image processing failed for ${file.originalname}, using original:`, processError);
          // Fall back to original if processing fails
        }

        // Upload to S3
        const uploadResult = await S3Service.uploadImage(
          processedBuffer,
          `listings/${id}`,
          finalFilename
        );

        // Create image record with atomic display_order calculation
        // This prevents race conditions when multiple images upload in parallel
        const imageId = `img_${Date.now()}_${i}_${Math.random().toString(36).substr(2, 9)}`;
        
        await prisma.$executeRaw`
          INSERT INTO images (id, listing_id, image_url, s3_key, display_order, created_at)
          VALUES (
            ${imageId},
            ${id},
            ${uploadResult.url},
            ${uploadResult.key},
            ${i},
            NOW()
          )
        `;

        console.log(`✅ Image ${i + 1} uploaded:`, uploadResult.url);
      }

      res.status(201).json({
        message: 'Images uploaded successfully',
        count: files.length
      });
    } catch (error) {
      console.error('Upload image error:', error);
      res.status(500).json({ error: 'Failed to upload images' });
    }
  }

  /**
   * Get all listings with filters (used for search)
   */
  static async getAllListings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const {
  page = '1',
  limit = '20',
  offset,  // ✅ ADD THIS LINE
  category,
        subcategory,
        condition,
        minPrice,
        maxPrice,
        q,
        keyword,
        seller_id,
        // Golf-specific filters
        brand,
        model,
        dexterity,
        shaftFlex,
        shaftMaterial,
        loft,
        lieAngle,
        gripSize,
        length,
        setMakeup,
        // Clothing filters
        gender,
        size,
        waist,
        color,
        clothingType,
        // Shoe filters
        shoeSize,
        spikes,
        // Accessory filters
        bagType,
        headcoverType,
        gloveSize,
        teeMaterial,
        teeStyle,
        slopeAdjust,
      } = req.query;

      console.log('🔍 Search params:', { category, subcategory, q, keyword, brand, model, dexterity, shaftFlex });

      const where: any = {
        status: 'active',
      };

      // Basic filters
      if (category) where.category = category;
      if (subcategory) where.subcategory = subcategory;
      if (condition) where.condition_overall = { gte: parseInt(condition as string) };
      if (seller_id) where.seller_id = seller_id;

      // Price range
      if (minPrice || maxPrice) {
        where.price = {};
        if (minPrice) where.price.gte = parseFloat(minPrice as string);
        if (maxPrice) where.price.lte = parseFloat(maxPrice as string);
      }

      // Text search
      if (q) {
        where.OR = [
          { title: { contains: q as string, mode: 'insensitive' } },
          { description: { contains: q as string, mode: 'insensitive' } },
        ];
      }

      // ✅ Keyword filter - searches across multiple fields including specifications
if (keyword) {
  const keywordStr = keyword as string;
  console.log('🔑 Keyword search:', keywordStr);
  
  // First, find listings where shaftModel contains the keyword
  const shaftModelMatches = await prisma.listing_attributes.findMany({
    where: {
      key: 'shaftModel',
      value: { contains: keywordStr, mode: 'insensitive' },
    },
    select: { listing_id: true },
  });
  
  const shaftMatchIds = shaftModelMatches.map(m => m.listing_id);
  console.log(`🔑 Shaft model matches: ${shaftMatchIds.length}`);
  
  // Build OR conditions for keyword search
  const keywordConditions: any[] = [
    { title: { contains: keywordStr, mode: 'insensitive' } },
    { description: { contains: keywordStr, mode: 'insensitive' } },
    { brand: { contains: keywordStr, mode: 'insensitive' } },
    { model: { contains: keywordStr, mode: 'insensitive' } },
  ];
  
  // Add shaft model matches if any
  if (shaftMatchIds.length > 0) {
    keywordConditions.push({ id: { in: shaftMatchIds } });
  }
  
  // If we already have OR conditions from 'q', we need to AND them together
  if (where.OR) {
    // Combine existing OR with keyword OR using AND
    where.AND = [
      { OR: where.OR },
      { OR: keywordConditions },
    ];
    delete where.OR;
  } else {
    where.OR = keywordConditions;
  }
}

      // Brand filter
      if (brand) {
        let cleanBrand = brand as string;
        if (cleanBrand.includes(',')) {
          cleanBrand = cleanBrand.split(',')[0].trim();
          console.log('⚠️ Brand had duplicates, cleaned to:', cleanBrand);
        }
        where.brand = { contains: cleanBrand, mode: 'insensitive' };
      }

      // Model filter
      if (model) {
        let cleanModel = model as string;
        if (cleanModel.includes(',')) {
          cleanModel = cleanModel.split(',')[0].trim();
        }
        where.model = { contains: cleanModel, mode: 'insensitive' };
      }

      console.log('📋 WHERE clause:', JSON.stringify(where, null, 2));

      // Build attribute filters for specifications
      const attributeFilters: any[] = [];

      // Golf club specifications
      if (dexterity) {
        attributeFilters.push({ key: 'dexterity', value: dexterity as string });
      }
      if (shaftFlex) {
        attributeFilters.push({ key: 'shaftFlex', value: shaftFlex as string });
      }
      if (shaftMaterial) {
        attributeFilters.push({ key: 'shaftMaterial', value: shaftMaterial as string });
      }
      if (loft) {
        attributeFilters.push({ key: 'loft', value: loft as string });
      }
      if (lieAngle) {
        attributeFilters.push({ key: 'lieAngle', value: lieAngle as string });
      }
      if (gripSize) {
        attributeFilters.push({ key: 'gripSize', value: gripSize as string });
      }
      if (length) {
        attributeFilters.push({ key: 'length', value: length as string });
      }

      // Iron set makeup (special handling - can be comma-separated)
      if (setMakeup) {
        const irons = (setMakeup as string).split(',');
        irons.forEach(iron => {
          attributeFilters.push({ key: 'setMakeup', value: iron.trim() });
        });
      }

      // Clothing filters
      if (gender) {
        attributeFilters.push({ key: 'gender', value: gender as string });
      }
      // ✅ SIZE VARIANT: Size handled specially below - NOT in attributeFilters
      if (waist) {
        attributeFilters.push({ key: 'waist', value: waist as string });
      }
      if (color) {
        attributeFilters.push({ key: 'color', value: color as string });
      }
      if (clothingType) {
        attributeFilters.push({ key: 'clothingType', value: clothingType as string });
      }

      // Shoe filters
      // ✅ SIZE VARIANT: shoeSize handled specially below - NOT in attributeFilters
      if (spikes) {
        attributeFilters.push({ key: 'spikes', value: spikes as string });
      }

      // Accessory filters
      if (bagType) {
        attributeFilters.push({ key: 'bagType', value: bagType as string });
      }
      if (headcoverType) {
        attributeFilters.push({ key: 'headcoverType', value: headcoverType as string });
      }
      if (gloveSize) {
        attributeFilters.push({ key: 'gloveSize', value: gloveSize as string });
      }
      if (teeMaterial) {
        attributeFilters.push({ key: 'teeMaterial', value: teeMaterial as string });
      }
      if (teeStyle) {
        attributeFilters.push({ key: 'teeStyle', value: teeStyle as string });
      }
      if (slopeAdjust) {
        attributeFilters.push({ key: 'slopeAdjust', value: slopeAdjust as string });
      }

      console.log('🔧 Attribute filters:', attributeFilters);

      // ✅ SIZE VARIANT: Handle size/shoeSize filtering specially
      // This matches BOTH single-size listings AND "Various" listings with that size in stock
      let sizeMatchingListingIds: Set<string> | null = null;
      
      if (size || shoeSize) {
        const sizeKey = shoeSize ? 'shoeSize' : 'size';
        const sizeValue = (shoeSize || size) as string;
        
        console.log(`📏 Size variant filter: ${sizeKey} = ${sizeValue}`);
        
        // Get listings with exact size match
        const exactSizeMatches = await prisma.listing_attributes.findMany({
          where: {
            key: sizeKey,
            value: sizeValue,
          },
          select: { listing_id: true },
        });
        
        console.log(`📏 Exact size matches: ${exactSizeMatches.length}`);
        
        // Get listings with "Various" size
        const variousMatches = await prisma.listing_attributes.findMany({
          where: {
            key: sizeKey,
            value: 'Various',
          },
          select: { listing_id: true },
        });
        
        console.log(`📏 Various size listings found: ${variousMatches.length}`);
        
        // For "Various" listings, check if they have stock for this size
        const variousListingIds = variousMatches.map(m => m.listing_id);
        let variousWithStock: string[] = [];
        
        if (variousListingIds.length > 0) {
          // Get the listings to check their specifications
          const variousListings = await prisma.listings.findMany({
            where: {
              id: { in: variousListingIds },
              status: 'active',
            },
            select: { id: true, specifications: true },
          });
          
          variousWithStock = variousListings
            .filter(listing => {
              const specs = listing.specifications as any;
              if (!specs?.sizeQuantities) return false;
              const qty = parseInt(specs.sizeQuantities[sizeValue]) || 0;
              return qty > 0;
            })
            .map(listing => listing.id);
          
          console.log(`📏 Various listings with ${sizeValue} in stock: ${variousWithStock.length}`);
        }
        
        // Combine exact matches + various with stock
        sizeMatchingListingIds = new Set([
          ...exactSizeMatches.map(m => m.listing_id),
          ...variousWithStock,
        ]);
        
        console.log(`📏 Total size matches: ${sizeMatchingListingIds.size}`);
      }

      // ✅ SIZE VARIANT: Apply size filter to WHERE clause
      if (sizeMatchingListingIds !== null) {
        if (sizeMatchingListingIds.size > 0) {
          where.id = { in: Array.from(sizeMatchingListingIds) };
        } else {
          // No size matches found - return empty
          console.log('📏 No size matches found, returning empty');
          res.json({
            listings: [],
            pagination: { total: 0, page: Number(page), limit: Number(limit), pages: 0 },
          });
          return;
        }
      }

      // If we have attribute filters, we need to join with listing_attributes
      let listings;
      let total;

      if (attributeFilters.length > 0) {
        // Get listing IDs that match ALL attribute filters
        const listingIdSets = await Promise.all(
          attributeFilters.map(async (filter) => {
            const attrs = await prisma.listing_attributes.findMany({
              where: {
                key: filter.key,
                value: filter.value,
              },
              select: { listing_id: true },
            });
            return new Set(attrs.map(a => a.listing_id));
          })
        );

        // Find intersection of all sets (listings that match ALL filters)
        let matchingListingIds: Set<string>;
        if (listingIdSets.length > 0) {
          matchingListingIds = listingIdSets[0];
          for (let i = 1; i < listingIdSets.length; i++) {
            matchingListingIds = new Set(
              [...matchingListingIds].filter(id => listingIdSets[i].has(id))
            );
          }
        } else {
          matchingListingIds = new Set();
        }

        console.log(`✅ Found ${matchingListingIds.size} listings matching attribute filters`);

        // If we already have size filter applied, intersect with attribute matches
        if (where.id?.in) {
          const sizeIds = new Set(where.id.in);
          const intersectedIds = [...matchingListingIds].filter(id => sizeIds.has(id));
          if (intersectedIds.length === 0) {
            res.json({
              listings: [],
              pagination: { total: 0, page: Number(page), limit: Number(limit), pages: 0 },
            });
            return;
          }
          where.id = { in: intersectedIds };
        } else if (matchingListingIds.size > 0) {
          where.id = { in: Array.from(matchingListingIds) };
        } else {
          // No matches, return empty
          res.json({
            listings: [],
            pagination: { total: 0, page: Number(page), limit: Number(limit), pages: 0 },
          });
          return;
        }
      }

      // Execute the query
      [listings, total] = await Promise.all([
        prisma.listings.findMany({
          where,
          include: {
            images: {
              orderBy: PRIMARY_IMAGE_ORDER,
              take: 1,
            },
            users: {
              select: {
                id: true,
                display_name: true,
                rating: true,
                is_verified_seller: true,
                is_pro_store: true,
                pro_store_name: true,
              },
            },
          },
          orderBy: { created_at: 'desc' },
          // ✅ Use offset if provided, otherwise calculate from page
          skip: offset !== undefined ? Number(offset) : (Number(page) - 1) * Number(limit),
          take: Number(limit),
        }),
        prisma.listings.count({ where }),
      ]);

      console.log(`✅ Returning ${listings.length} listings (total: ${total})`);

      // listings already include users from the JOIN above
      const listingsWithSellers = listings;

      res.json({
        listings: listingsWithSellers,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          pages: Math.ceil(total / Number(limit)),
        },
      });
    } catch (error) {
      console.error('❌ Get listings error:', error);
      res.status(500).json({ error: 'Failed to get listings' });
    }
  }

  /**
   * Get single listing by ID
   * UPDATED: Now includes favorite_count from favorites table
   */
  static async getListingById(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const listing = await prisma.listings.findUnique({
        where: { id },
        include: {
          images: {
            orderBy: PRIMARY_IMAGE_ORDER,
          },
        },
      });

      if (!listing || listing.status === 'deleted') {
        res.status(404).json({ error: 'Listing not found' });
        return;
      }

      const viewerId = req.user?.id;
      if (listing.status === 'draft' && listing.seller_id !== viewerId) {
        res.status(404).json({ error: 'Listing not found' });
        return;
      }

      // Get seller info
      const seller = await prisma.users.findUnique({
        where: { id: listing.seller_id },
       select: {
          id: true,
          display_name: true,
          rating: true,
          avatar_url: true,
          is_verified_seller: true,
          is_pro_store: true,
          pro_store_name: true,
        },
      });

      // Count favorites for this listing
      const favoriteCount = await prisma.favorites.count({
        where: { listing_id: id },
      });

      // Bug 1 (F2): Look up authenticated buyer's accepted offer on this listing
      let viewer_active_offer: {
        offer_id: string;
        offer_amount: string;
        accepted_at: string;
        expires_at: string;
        status: string;
      } | null = null;

      if (viewerId && viewerId !== listing.seller_id) {
        const activeOffer = await prisma.offers.findFirst({
          where: {
            listing_id: id,
            buyer_id: viewerId,
            status: { in: ['ACCEPTED', 'COUNTER_ACCEPTED'] },
            acceptance_expires_at: { gt: new Date() },
          },
          orderBy: { created_at: 'desc' },
          select: {
            id: true,
            final_amount: true,
            responded_at: true,
            acceptance_expires_at: true,
            status: true,
          },
        });

        if (activeOffer && activeOffer.final_amount && activeOffer.acceptance_expires_at) {
          viewer_active_offer = {
            offer_id: activeOffer.id,
            offer_amount: activeOffer.final_amount.toString(),
            accepted_at: activeOffer.responded_at?.toISOString() || '',
            expires_at: activeOffer.acceptance_expires_at.toISOString(),
            status: activeOffer.status,
          };
        }
      }

      res.json({ 
        listing: { 
          ...listing, 
          seller,
          favorite_count: favoriteCount,
          viewer_active_offer,
        } 
      });
    } catch (error) {
      console.error('Get listing error:', error);
      res.status(500).json({ error: 'Failed to get listing' });
    }
  }

  /**
   * Get listings by seller
   */
  static async getSellerListings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { seller_id } = req.params;

      const listings = await prisma.listings.findMany({
        where: {
          seller_id: seller_id,
          status: 'active'
        },
        include: {
          images: {
            orderBy: PRIMARY_IMAGE_ORDER,
            take: 1,
          },
          users: {
            select: {
              id: true,
              display_name: true,
              rating: true,
              avatar_url: true,
              is_verified_seller: true,
              is_pro_store: true,
              pro_store_name: true,
            },
          },
        },
        orderBy: { created_at: 'desc' }
      });

      res.json({ listings });
    } catch (error) {
      console.error('Get seller listings error:', error);
      res.status(500).json({ error: 'Failed to get seller listings' });
    }
  }

  /**
   * Update listing
   */
  static async updateListing(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user!.id;

      const {
        title,
        description,
        price,
        category,
        subcategory,
        brand,
        model,
        condition_overall,
        condition_head,
        condition_shaft,
        condition_grip,
        ball_condition_type,
        specifications,
        location,
        is_negotiable,
        status,
        parcel_size,
        shipping_cost,
        quantity,
      } = req.body;

      // Verify listing exists and belongs to user
      const listing = await prisma.listings.findUnique({
        where: { id },
      });

      if (!listing) {
        res.status(404).json({ error: 'Listing not found' });
        return;
      }

      if (listing.seller_id !== userId) {
        res.status(403).json({ error: 'Unauthorized' });
        return;
      }

      // Calculate average condition for clubs
      let finalConditionOverall = condition_overall;
      
      if (category === 'Clubs' && condition_head && condition_shaft && condition_grip) {
        finalConditionOverall = Math.round(
          (parseInt(condition_head) + parseInt(condition_shaft) + parseInt(condition_grip)) / 3
        );
        console.log(`📊 Club condition updated: Head(${condition_head}) + Shaft(${condition_shaft}) + Grip(${condition_grip}) = Overall(${finalConditionOverall})`);
      }

      // Update the listing - ONLY update fields that are provided
      const updateData: any = {
        updated_at: new Date(),
      };

      if (title !== undefined) updateData.title = title;
      if (description !== undefined) updateData.description = description;
      if (price !== undefined) updateData.price = parseFloat(price);
      if (category !== undefined) updateData.category = category;
      if (subcategory !== undefined) updateData.subcategory = subcategory || null;
      if (brand !== undefined) updateData.brand = brand || null;
      if (model !== undefined) updateData.model = model || null;
      if (condition_overall !== undefined || finalConditionOverall !== undefined) {
        updateData.condition_overall = finalConditionOverall || condition_overall || null;
      }
      if (condition_head !== undefined) updateData.condition_head = condition_head || null;
      if (condition_shaft !== undefined) updateData.condition_shaft = condition_shaft || null;
      if (condition_grip !== undefined) updateData.condition_grip = condition_grip || null;
      if (ball_condition_type !== undefined) updateData.ball_condition_type = ball_condition_type || null;
      if (specifications !== undefined) updateData.specifications = specifications || null;
      if (location !== undefined) updateData.location = location || null;
      if (is_negotiable !== undefined) updateData.is_negotiable = is_negotiable;
      if (status !== undefined) updateData.status = status;
      if (parcel_size !== undefined) updateData.parcel_size = parcel_size || null;
      if (shipping_cost !== undefined) updateData.shipping_cost = shipping_cost ? parseFloat(shipping_cost) : null;
      // ✅ SIZE VARIANT: Auto-calculate quantity from sizeQuantities if present
      if (specifications?.sizeQuantities) {
        updateData.quantity = calculateTotalFromSizeQuantities(specifications) || (quantity ? parseInt(quantity) : 1);
      } else if (quantity !== undefined) {
        updateData.quantity = parseInt(quantity) || 1;
      }

      console.log('📝 Updating listing with fields:', Object.keys(updateData));

      const updatedListing = await prisma.listings.update({
        where: { id },
        data: updateData,
      });

      // Update listing_attributes
      if (specifications && typeof specifications === 'object') {
        // Delete existing attributes
        await prisma.listing_attributes.deleteMany({
          where: { listing_id: id }
        });

        // Insert new attributes
        const attributeRecords: any[] = [];
        
        Object.entries(specifications).forEach(([key, value]) => {
          if (key === 'setMakeup' && Array.isArray(value)) {
            value.forEach((iron: string) => {
              attributeRecords.push({
                id: `attr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                listing_id: id,
                key: 'setMakeup',
                value: iron,
                created_at: new Date(),
              });
            });
          } else {
            attributeRecords.push({
              id: `attr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              listing_id: id,
              key: key,
              value: typeof value === 'string' ? value : JSON.stringify(value),
              created_at: new Date(),
            });
          }
        });

        if (attributeRecords.length > 0) {
          await prisma.listing_attributes.createMany({
            data: attributeRecords,
          });
          console.log(`✅ Updated ${attributeRecords.length} attributes`);
        }
      }

      // Fetch complete updated listing
      const completeListingData = await prisma.listings.findUnique({
        where: { id },
        include: {
          images: {
            orderBy: PRIMARY_IMAGE_ORDER,
          },
          listing_attributes: true,
        },
      });

      res.json({ listing: completeListingData });
    } catch (error) {
      console.error('Update listing error:', error);
      res.status(500).json({ error: 'Failed to update listing' });
    }
  }

  /**
   * Delete listing
   */
  static async deleteListing(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = req.user!.id;

      // Verify listing exists and belongs to user
      const listing = await prisma.listings.findUnique({
        where: { id },
        include: { images: true },
      });

      if (!listing) {
        res.status(404).json({ error: 'Listing not found' });
        return;
      }

      if (listing.seller_id !== userId) {
        res.status(403).json({ error: 'Unauthorized' });
        return;
      }

      // Already deleted — idempotent
      if (listing.status === 'deleted') {
        res.json({ message: 'Listing deleted successfully' });
        return;
      }

      // Check for active orders before allowing deletion
      const ACTIVE_ORDER_STATUSES = ['pending', 'paid', 'to_ship', 'shipped', 'in_transit', 'delivered'];

      const activeOrders = await prisma.orders.findFirst({
        where: {
          listing_id: id,
          status: { in: ACTIVE_ORDER_STATUSES },
        },
        select: {
          id: true,
          status: true,
        },
      });

      if (activeOrders) {
        console.log(`🚫 Cannot delete listing ${id} - has active order ${activeOrders.id} (status: ${activeOrders.status})`);

        let message = 'This listing has an active order and cannot be deleted.';

        if (['pending', 'paid', 'to_ship'].includes(activeOrders.status)) {
          message = 'This listing has an order waiting to be shipped. Please ship the item first.';
        } else if (['shipped', 'in_transit'].includes(activeOrders.status)) {
          message = 'This listing has an order in transit. Please wait until delivery.';
        } else if (activeOrders.status === 'delivered') {
          message = 'This listing has a recently delivered order. Please wait until transaction completes.';
        }

        res.status(400).json({
          error: message,
          order_status: activeOrders.status,
        });
        return;
      }

      // Soft delete — preserve data for historical orders/offers
      await prisma.listings.update({
        where: { id },
        data: { status: 'deleted', deleted_at: new Date(), updated_at: new Date() },
      });

      res.json({ message: 'Listing deleted successfully' });
    } catch (error) {
      console.error('Delete listing error:', error);
      res.status(500).json({ error: 'Failed to delete listing' });
    }
  }

  /**
   * Delete listing image
   */
  static async deleteListingImage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id, imageId } = req.params;
      const userId = req.user!.id;

      // Verify listing exists and belongs to user
      const listing = await prisma.listings.findUnique({
        where: { id },
      });

      if (!listing) {
        res.status(404).json({ error: 'Listing not found' });
        return;
      }

      if (listing.seller_id !== userId) {
        res.status(403).json({ error: 'Unauthorized' });
        return;
      }

      // Get image
      const image = await prisma.images.findUnique({
        where: { id: imageId },
      });

      if (!image) {
        res.status(404).json({ error: 'Image not found' });
        return;
      }

      // Delete from S3
      await S3Service.deleteImage(image.s3_key);

      // Delete from database
      await prisma.images.delete({
        where: { id: imageId },
      });

     res.json({ message: 'Image deleted successfully' });
    } catch (error) {
      console.error('Delete image error:', error);
      res.status(500).json({ error: 'Failed to delete image' });
    }
  }

  /**
   * Track a view for a listing
   * POST /listings/:id/view
   */
  static async trackView(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const viewerId = req.user?.id;

      console.log('👁️ POST /listings/:id/view - Listing:', id, 'Viewer:', viewerId || 'anonymous');

      // Check listing exists
      const listing = await prisma.listings.findUnique({
        where: { id },
        select: { 
          id: true, 
          seller_id: true,
          views: true,
        },
      });

      if (!listing) {
        res.status(404).json({ error: 'Listing not found' });
        return;
      }

      // Don't count views from the seller themselves
      if (viewerId && listing.seller_id === viewerId) {
        console.log('📊 Skipping view - seller viewing own listing');
        res.json({ success: true, views: listing.views, counted: false });
        return;
      }

      // Increment view count
      const updatedListing = await prisma.listings.update({
        where: { id },
        data: {
          views: { increment: 1 },
        },
        select: { views: true },
      });

      console.log('✅ View tracked - new count:', updatedListing.views);
      res.json({ 
        success: true, 
        views: updatedListing.views,
        counted: true,
      });
    } catch (error) {
      console.error('❌ Track view error:', error);
      res.status(500).json({ error: 'Failed to track view' });
    }
  }

  static async bulkUpdateListings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const { ids, status, price, price_adjustment_percent, original_price } = req.body;

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({ error: 'ids must be a non-empty array' });
        return;
      }

      // Verify all listings belong to this seller
      const owned = await prisma.listings.count({
        where: { id: { in: ids }, seller_id: userId },
      });

      if (owned !== ids.length) {
        res.status(403).json({ error: 'You do not own all of these listings' });
        return;
      }

      const updateData: Record<string, unknown> = {};

      if (status) {
        updateData.status = status;
      }

      if (price !== undefined) {
        updateData.price = String(price);
        if (original_price !== undefined) {
          updateData.original_price = String(original_price);
        }
      }

      if (price_adjustment_percent !== undefined) {
        // Apply percentage adjustment to each listing individually
        const listings = await prisma.listings.findMany({
          where: { id: { in: ids } },
          select: { id: true, price: true },
        });

        await Promise.all(
          listings.map((listing) => {
            const currentPrice = parseFloat(listing.price.toString());
            const newPrice = currentPrice * (1 + price_adjustment_percent / 100);
            return prisma.listings.update({
              where: { id: listing.id },
              data: { price: String(Math.max(0, newPrice).toFixed(2)) },
            });
          })
        );

        res.json({ updated: ids.length });
        return;
      }

      if (Object.keys(updateData).length === 0) {
        res.status(400).json({ error: 'No update data provided' });
        return;
      }

      await prisma.listings.updateMany({
        where: { id: { in: ids }, seller_id: userId },
        data: updateData,
      });

      res.json({ updated: ids.length });
    } catch (error) {
      console.error('❌ Bulk update listings error:', error);
      res.status(500).json({ error: 'Failed to bulk update listings' });
    }
  }

  static async bulkDeleteListings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.user!.id;
      const { ids } = req.body;

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({ error: 'ids must be a non-empty array' });
        return;
      }

      // Verify all listings belong to this seller
      const owned = await prisma.listings.count({
        where: { id: { in: ids }, seller_id: userId },
      });

      if (owned !== ids.length) {
        res.status(403).json({ error: 'You do not own all of these listings' });
        return;
      }

      // Soft delete — set status to deleted
      await prisma.listings.updateMany({
        where: { id: { in: ids }, seller_id: userId },
        data: { status: 'deleted' },
      });

      res.json({ deleted: ids.length });
    } catch (error) {
      console.error('❌ Bulk delete listings error:', error);
      res.status(500).json({ error: 'Failed to bulk delete listings' });
    }
  }
} 