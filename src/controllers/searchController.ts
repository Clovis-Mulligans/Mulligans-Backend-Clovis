// src/controllers/searchController.ts
// ✅ FIXED: Strict matching for suggestions - no more false positives
import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth';

const prisma = new PrismaClient();

// ============================================================================
// BRAND & CATEGORY DATA FOR SUGGESTIONS
// ============================================================================

const CLUB_BRANDS = [
  'TaylorMade', 'Callaway', 'Titleist', 'Ping', 'Cobra', 'Mizuno', 'Srixon', 'Wilson',
  'Cleveland', 'PXG', 'Honma', 'Tour Edge', 'Adams', 'Ben Hogan', 'Bridgestone',
  'LA Golf', 'LAB Golf', 'Dunlop', 'MacGregor', 'Lynx', 'Tommy Armour', 'Top Flite',
  'Nickent', 'Pinemeadow', 'Ram', 'Snake Eyes', 'Square Strike', 'Sub 70', 'Teton',
  'Warrior', 'Yonex', 'Scotty Cameron', 'Odyssey', 'Bettinardi', 'Evnroll'
];

const CLOTHING_BRANDS = [
  'Malbon Golf', 'Manors Golf', 'G/FORE', 'Greyson', 'J.Lindeberg', 'Radmor',
  'Jones Golf', 'Bad Birdie', 'Bonobos Golf', 'Dunning Golf', 'TravisMathew',
  'Nike', 'Adidas', 'Under Armour', 'Puma', 'FootJoy', 'Lululemon',
  'Ralph Lauren', 'Hugo Boss', 'Lacoste', 'Tommy Hilfiger',
  'Callaway Apparel', 'TaylorMade Apparel', 'Ping Apparel'
];

const SHOE_BRANDS = [
  'FootJoy', 'Adidas', 'Nike', 'Puma', 'Ecco', 'Skechers', 'New Balance',
  'Under Armour', 'True Linkswear', 'G/FORE', 'Cuater', 'Malbon Golf'
];

const ACCESSORY_BRANDS = [
  'TaylorMade', 'Callaway', 'Titleist', 'Ping', 'Sun Mountain', 'Bushnell',
  'Garmin', 'FootJoy', 'Nike', 'Vessel', 'Scotty Cameron', 'Jones', 'Stitch'
];

// All unique brands combined
const ALL_BRANDS = [...new Set([...CLUB_BRANDS, ...CLOTHING_BRANDS, ...SHOE_BRANDS, ...ACCESSORY_BRANDS])];

// Categories and their subcategories
const CATEGORIES: Record<string, string[]> = {
  'Clubs': ['Drivers', 'Fairway Woods', 'Hybrids', 'Irons', 'Wedges', 'Putters'],
  'Shafts, Grips & Heads': ['Shafts', 'Grips', 'Heads'],
  'Clothing': ['Jackets', 'Polo Shirts', 'Trousers', 'Shorts', 'Hoodies', 'Knitwear', 'Gilets', 'Mid-Layers', 'Waterproofs'],
  'Shoes': ['Golf Shoes'],
  'Accessories': ['Bags', 'Headcovers', 'Gloves', 'Tees', 'Rangefinders', 'Launch Monitors', 'Towels'],
  'Balls': ['New', 'Used/Lake'],
  'Training Aids': ['Training Aids'],
};

// ✅ FIXED: Strict brand to category mapping - only valid combinations
const BRAND_CATEGORY_MAP: Record<string, { category: string; subcategories: string[] }[]> = {
  // Club brands - ONLY clubs
  'TaylorMade': [{ category: 'Clubs', subcategories: ['Drivers', 'Fairway Woods', 'Hybrids', 'Irons', 'Wedges', 'Putters'] }],
  'Callaway': [{ category: 'Clubs', subcategories: ['Drivers', 'Fairway Woods', 'Hybrids', 'Irons', 'Wedges', 'Putters'] }],
  'Titleist': [{ category: 'Clubs', subcategories: ['Drivers', 'Fairway Woods', 'Hybrids', 'Irons', 'Wedges', 'Putters'] }],
  'Ping': [{ category: 'Clubs', subcategories: ['Drivers', 'Fairway Woods', 'Hybrids', 'Irons', 'Wedges', 'Putters'] }],
  'Cobra': [{ category: 'Clubs', subcategories: ['Drivers', 'Fairway Woods', 'Hybrids', 'Irons', 'Wedges', 'Putters'] }],
  'Mizuno': [{ category: 'Clubs', subcategories: ['Drivers', 'Fairway Woods', 'Hybrids', 'Irons', 'Wedges', 'Putters'] }],
  'Srixon': [{ category: 'Clubs', subcategories: ['Drivers', 'Fairway Woods', 'Hybrids', 'Irons', 'Wedges', 'Putters'] }],
  'Cleveland': [{ category: 'Clubs', subcategories: ['Drivers', 'Fairway Woods', 'Hybrids', 'Wedges', 'Putters'] }],
  'PXG': [{ category: 'Clubs', subcategories: ['Drivers', 'Fairway Woods', 'Hybrids', 'Irons', 'Wedges', 'Putters'] }],
  'Wilson': [{ category: 'Clubs', subcategories: ['Drivers', 'Fairway Woods', 'Hybrids', 'Irons', 'Wedges', 'Putters'] }],
  'Bridgestone': [{ category: 'Clubs', subcategories: ['Drivers', 'Fairway Woods', 'Irons', 'Putters'] }],
  'Honma': [{ category: 'Clubs', subcategories: ['Drivers', 'Fairway Woods', 'Irons', 'Putters'] }],
  
  // Putter-specific brands
  'Scotty Cameron': [{ category: 'Clubs', subcategories: ['Putters'] }],
  'Odyssey': [{ category: 'Clubs', subcategories: ['Putters'] }],
  'Bettinardi': [{ category: 'Clubs', subcategories: ['Putters'] }],
  'LAB Golf': [{ category: 'Clubs', subcategories: ['Putters'] }],
  'Evnroll': [{ category: 'Clubs', subcategories: ['Putters'] }],
  
  // Clothing brands - ONLY clothing
  'Malbon Golf': [{ category: 'Clothing', subcategories: ['Jackets', 'Polo Shirts', 'Hoodies'] }],
  'Manors Golf': [{ category: 'Clothing', subcategories: ['Jackets', 'Polo Shirts', 'Trousers', 'Knitwear'] }],
  'G/FORE': [{ category: 'Clothing', subcategories: ['Polo Shirts', 'Jackets'] }, { category: 'Shoes', subcategories: ['Golf Shoes'] }],
  'J.Lindeberg': [{ category: 'Clothing', subcategories: ['Jackets', 'Polo Shirts', 'Trousers'] }],
  'TravisMathew': [{ category: 'Clothing', subcategories: ['Polo Shirts', 'Shorts', 'Jackets'] }],
  'Greyson': [{ category: 'Clothing', subcategories: ['Polo Shirts', 'Jackets'] }],
  'Bad Birdie': [{ category: 'Clothing', subcategories: ['Polo Shirts'] }],
  'Tommy Hilfiger': [{ category: 'Clothing', subcategories: ['Polo Shirts', 'Jackets'] }],
  'Ralph Lauren': [{ category: 'Clothing', subcategories: ['Polo Shirts', 'Jackets'] }],
  'Hugo Boss': [{ category: 'Clothing', subcategories: ['Polo Shirts', 'Jackets', 'Trousers'] }],
  'Lacoste': [{ category: 'Clothing', subcategories: ['Polo Shirts'] }],
  
  // Multi-category brands
  'Nike': [
    { category: 'Clothing', subcategories: ['Polo Shirts', 'Jackets', 'Trousers'] },
    { category: 'Shoes', subcategories: ['Golf Shoes'] }
  ],
  'Adidas': [
    { category: 'Clothing', subcategories: ['Polo Shirts', 'Jackets', 'Trousers'] },
    { category: 'Shoes', subcategories: ['Golf Shoes'] }
  ],
  'Puma': [
    { category: 'Clothing', subcategories: ['Polo Shirts', 'Jackets'] },
    { category: 'Shoes', subcategories: ['Golf Shoes'] }
  ],
  'Under Armour': [
    { category: 'Clothing', subcategories: ['Polo Shirts', 'Jackets'] },
    { category: 'Shoes', subcategories: ['Golf Shoes'] }
  ],
  'FootJoy': [
    { category: 'Clothing', subcategories: ['Polo Shirts', 'Jackets'] },
    { category: 'Shoes', subcategories: ['Golf Shoes'] },
    { category: 'Accessories', subcategories: ['Gloves'] }
  ],
  
  // Shoe brands - ONLY shoes
  'Ecco': [{ category: 'Shoes', subcategories: ['Golf Shoes'] }],
  'Skechers': [{ category: 'Shoes', subcategories: ['Golf Shoes'] }],
  'New Balance': [{ category: 'Shoes', subcategories: ['Golf Shoes'] }],
  'True Linkswear': [{ category: 'Shoes', subcategories: ['Golf Shoes'] }],
  'Cuater': [{ category: 'Shoes', subcategories: ['Golf Shoes'] }],
  
  // Accessory brands
  'Bushnell': [{ category: 'Accessories', subcategories: ['Rangefinders'] }],
  'Garmin': [{ category: 'Accessories', subcategories: ['Rangefinders'] }],
  'Sun Mountain': [{ category: 'Accessories', subcategories: ['Bags'] }],
  'Vessel': [{ category: 'Accessories', subcategories: ['Bags'] }],
  'Jones': [{ category: 'Accessories', subcategories: ['Bags'] }],
  'Stitch': [{ category: 'Accessories', subcategories: ['Bags', 'Headcovers'] }],
};

// ============================================================================
// ✅ FIXED: STRICT MATCHING - No more false positives
// ============================================================================

/**
 * Strict match - only matches if:
 * 1. Target starts with query (case insensitive)
 * 2. Query is a word within target
 * 3. Very close typo (1 character off for queries >= 4 chars)
 */
function strictMatch(query: string, target: string): boolean {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase();
  
  // Empty query matches nothing
  if (q.length === 0) return false;
  
  // Exact match
  if (t === q) return true;
  
  // Target starts with query
  if (t.startsWith(q)) return true;
  
  // Query is a complete word in target (for multi-word targets)
  const words = t.split(/\s+/);
  for (const word of words) {
    if (word.startsWith(q)) return true;
  }
  
  // For longer queries (4+ chars), allow 1 character typo using simple check
  if (q.length >= 4) {
    // Check if removing any single char from query makes it match start of target
    for (let i = 0; i < q.length; i++) {
      const qWithoutChar = q.slice(0, i) + q.slice(i + 1);
      if (t.startsWith(qWithoutChar) && qWithoutChar.length >= 3) {
        return true;
      }
    }
    
    // Check if target starts with query minus last char (common typo)
    if (t.startsWith(q.slice(0, -1)) && q.length >= 4) {
      return true;
    }
  }
  
  return false;
}

// ============================================================================
// SIZE VARIANT: Helper to get the specs key for size based on category
// ============================================================================

function getSizeSpecKey(category: string | undefined): string {
  if (category === 'Shoes') return 'shoeSize';
  return 'size'; // Clothing
}

// ============================================================================
// SEARCH CONTROLLER
// ============================================================================

export class SearchController {
  /**
   * ✅ FIXED: Get search suggestions with strict matching
   * GET /api/search/suggestions?q=taylor
   */
  static async getSuggestions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const query = (req.query.q as string || '').trim();
      
      if (query.length < 2) {
        res.json({ suggestions: [] });
        return;
      }

      console.log('🔍 Suggestions query:', query);

      const suggestions: any[] = [];
      const addedTexts = new Set<string>(); // Prevent duplicates

      // Helper to add unique suggestions
      const addSuggestion = (suggestion: any) => {
        const key = suggestion.text.toLowerCase();
        if (!addedTexts.has(key) && suggestions.length < 10) {
          addedTexts.add(key);
          suggestions.push(suggestion);
        }
      };

      // ✅ FIXED: 1. MATCH BRANDS (strict matching only)
      const matchingBrands: string[] = [];
      for (const brand of ALL_BRANDS) {
        if (strictMatch(query, brand)) {
          matchingBrands.push(brand);
        }
      }
      
      console.log('📋 Matching brands:', matchingBrands);
      
      // Add top 3 brand suggestions
      for (const brand of matchingBrands.slice(0, 3)) {
        addSuggestion({
          text: brand,
          type: 'brand',
          icon: 'pricetag-outline',
          filters: { brand },
        });
      }

      // ✅ FIXED: 2. MATCH SUBCATEGORIES (strict matching)
      for (const [category, subcategories] of Object.entries(CATEGORIES)) {
        for (const subcategory of subcategories) {
          if (strictMatch(query, subcategory)) {
            addSuggestion({
              text: subcategory,
              type: 'subcategory',
              icon: category === 'Clubs' ? 'golf-outline' : 
                    category === 'Clothing' ? 'shirt-outline' :
                    category === 'Shoes' ? 'footsteps-outline' : 'cube-outline',
              filters: { category, subcategory },
            });
          }
        }
      }

      // ✅ FIXED: 3. CREATE BRAND + SUBCATEGORY COMBINATIONS (only valid ones!)
      // Only for the FIRST matching brand, show ALL their valid subcategories
      if (matchingBrands.length > 0) {
        const primaryBrand = matchingBrands[0];
        const brandCategories = BRAND_CATEGORY_MAP[primaryBrand];
        
        if (brandCategories) {
          for (const { category, subcategories } of brandCategories) {
            // ✅ UPDATED: Show ALL subcategories for club brands (most important)
            // For other categories (clothing, shoes), limit to 2 to avoid overwhelming
            const limitSubcategories = category === 'Clubs' ? subcategories : subcategories.slice(0, 2);
            
            for (const subcategory of limitSubcategories) {
              const combinedText = `${primaryBrand} ${subcategory}`;
              
              addSuggestion({
                text: combinedText,
                type: 'combination',
                icon: category === 'Clubs' ? 'golf-outline' : 
                      category === 'Clothing' ? 'shirt-outline' :
                      category === 'Shoes' ? 'footsteps-outline' : 'cube-outline',
                filters: { brand: primaryBrand, category, subcategory },
              });
            }
          }
        }
      }

      // ✅ FIXED: 4. Check if query contains both brand AND subcategory
      // e.g., "Titleist Wedge" -> brand=Titleist, subcategory=Wedges
      const queryWords = query.toLowerCase().split(/\s+/);
      if (queryWords.length >= 2) {
        let foundBrand: string | null = null;
        let foundSubcategory: string | null = null;
        let foundCategory: string | null = null;
        
        // Find brand in query
        for (const brand of ALL_BRANDS) {
          for (const word of queryWords) {
            if (strictMatch(word, brand)) {
              foundBrand = brand;
              break;
            }
          }
          if (foundBrand) break;
        }
        
        // Find subcategory in query
        for (const [category, subcategories] of Object.entries(CATEGORIES)) {
          for (const subcategory of subcategories) {
            for (const word of queryWords) {
              if (strictMatch(word, subcategory)) {
                foundSubcategory = subcategory;
                foundCategory = category;
                break;
              }
            }
            if (foundSubcategory) break;
          }
          if (foundSubcategory) break;
        }
        
        // If we found both, add as top suggestion
        if (foundBrand && foundSubcategory && foundCategory) {
          // Verify this is a valid combination
          const brandCats = BRAND_CATEGORY_MAP[foundBrand];
          const isValid = brandCats?.some(bc => 
            bc.category === foundCategory && bc.subcategories.includes(foundSubcategory!)
          );
          
          if (isValid) {
            // Insert at beginning
            suggestions.unshift({
              text: `${foundBrand} ${foundSubcategory}`,
              type: 'combination',
              icon: 'golf-outline',
              filters: { brand: foundBrand, category: foundCategory, subcategory: foundSubcategory },
            });
            addedTexts.add(`${foundBrand} ${foundSubcategory}`.toLowerCase());
          }
        }
      }

      // 5. SEARCH ACTUAL LISTINGS (title/brand matches)
      const listingResults = await prisma.listings.findMany({
        where: {
          status: 'active',
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { brand: { contains: query, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          title: true,
          brand: true,
          category: true,
          subcategory: true,
          images: {
            select: { image_url: true },
            take: 1,
            orderBy: { display_order: 'asc' },
          },
        },
        take: 3,
        orderBy: { created_at: 'desc' },
      });

      for (const listing of listingResults) {
        addSuggestion({
          text: listing.title,
          type: 'listing',
          icon: 'cube-outline',
          listingId: listing.id,
          image: listing.images[0]?.image_url || null,
          filters: {
            brand: listing.brand,
            category: listing.category,
            subcategory: listing.subcategory,
          },
        });
      }

      // 6. SEARCH USERS (by display name)
      const userResults = await prisma.users.findMany({
        where: {
          display_name: { contains: query, mode: 'insensitive' },
        },
        select: {
          id: true,
          display_name: true,
          avatar_url: true,
        },
        take: 3,
        orderBy: { created_at: 'desc' },
      });

      for (const user of userResults) {
        addSuggestion({
          text: user.display_name || 'User',
          type: 'user',
          icon: 'person-outline',
          userId: user.id,
          image: user.avatar_url || null,
        });
      }

      // Limit total suggestions to 10
      const limitedSuggestions = suggestions.slice(0, 10);

      console.log(`✅ Found ${limitedSuggestions.length} suggestions for "${query}":`, 
        limitedSuggestions.map(s => s.text));

      res.json({ suggestions: limitedSuggestions });
    } catch (error) {
      console.error('❌ Suggestions error:', error);
      res.status(500).json({ error: 'Failed to get suggestions' });
    }
  }

  /**
   * Advanced search with category-specific filters
   */
  static async advancedSearch(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const {
        query,
        category,
        subcategory,
        minPrice,
        maxPrice,
        condition,
        location,
        brand,
        gender,
        dexterity,
        size,
        color,
        setMakeup,
        loft,           
        lieAngle,     
        length,        
        gripSize,       
        shaftFlex,     
        shaftMaterial, 
        page = 1,
        limit = 20,
        sortBy = 'created_at',
        sortOrder = 'desc',
      } = req.query;

      console.log('🔍 SEARCH REQUEST:', { category, subcategory, query, brand });
      
      const skip = (Number(page) - 1) * Number(limit);

      const where: any = {
        status: 'active',
      };

      // ✅ FIXED: Handle text search properly
      if (query) {
        where.OR = [
          { title: { contains: query as string, mode: 'insensitive' } },
          { description: { contains: query as string, mode: 'insensitive' } },
          { brand: { contains: query as string, mode: 'insensitive' } },
          { model: { contains: query as string, mode: 'insensitive' } },
        ];
      }

      // Handle category/subcategory filtering
      if (subcategory) {
        where.category = category;
        where.subcategory = subcategory;
      } else if (category) {
        where.category = category;
      }

      // ✅ FIXED: Handle brand filter properly
      if (brand) {
        where.brand = { contains: brand as string, mode: 'insensitive' };
      }

      // Handle condition filter (frontend sends numbers 1-5)
      if (condition) {
        const conditionValue = Number(condition);
        if (conditionValue >= 1 && conditionValue <= 5) {
          where.condition_overall = { gte: conditionValue };
        }
      }

      if (minPrice || maxPrice) {
        where.price = {};
        if (minPrice) where.price.gte = Number(minPrice);
        if (maxPrice) where.price.lte = Number(maxPrice);
      }

      if (location) {
        where.location = {
          contains: location as string,
          mode: 'insensitive',
        };
      }

      const attributeFilters: any = {};
if (gender) attributeFilters.gender = gender;
if (dexterity) attributeFilters.dexterity = dexterity;
// ✅ SIZE VARIANT: Size filtering handled separately below
// if (size) attributeFilters.size = size;  // REMOVED - handled specially
if (color) attributeFilters.color = color;
      if (loft) attributeFilters.loft = loft;               
      if (lieAngle) attributeFilters.lieAngle = lieAngle;   
      if (length) attributeFilters.length = length;        
      if (gripSize) attributeFilters.gripSize = gripSize;   
      if (shaftFlex) attributeFilters.shaftFlex = shaftFlex; 
      if (shaftMaterial) attributeFilters.shaftMaterial = shaftMaterial;

      // Build AND conditions for listing_attributes
      const attributeAndConditions: any[] = [];

      Object.entries(attributeFilters).forEach(([key, value]) => {
        const numericFields = ['loft', 'lieAngle', 'length', 'waist', 'size'];
        const isNumeric = numericFields.includes(key);
        
        attributeAndConditions.push({
          listing_attributes: {
            some: {
              key: key,
              value: isNumeric 
                ? value as string
                : { contains: value as string, mode: 'insensitive' },
            }
          }
        });
      });

      if (setMakeup) {
        try {
          const selectedIrons = typeof setMakeup === 'string' ? JSON.parse(setMakeup) : setMakeup;
          if (Array.isArray(selectedIrons) && selectedIrons.length > 0) {
            const ironOrConditions = selectedIrons.map((iron: string) => ({
              key: 'setMakeup',
              value: iron
            }));
            
            attributeAndConditions.push({
              listing_attributes: {
                some: {
                  OR: ironOrConditions
                }
              }
            });
          }
        } catch (e) {
          console.error('❌ Error parsing setMakeup:', e);
        }
      }

      if (attributeAndConditions.length > 0) {
        if (!where.AND) {
          where.AND = [];
        }
        where.AND.push(...attributeAndConditions);
      }

     // ✅ SIZE VARIANT: Handle size filtering for both single-size and "Various" listings
if (size) {
  const sizeValue = size as string;
  const isClothingOrShoes = category === 'Clothing' || category === 'Shoes';
  
  if (isClothingOrShoes) {
    const sizeSpecKey = category === 'Shoes' ? 'shoeSize' : 'size';
    
    if (!where.AND) {
      where.AND = [];
    }
    
    // Match EITHER the exact size OR "Various" (which contains multiple sizes)
    where.AND.push({
      OR: [
        // Option 1: Single size listing
        {
          listing_attributes: {
            some: {
              key: sizeSpecKey,
              value: sizeValue,
            }
          }
        },
        // Option 2: Various listing (we'll filter by actual stock in app later)
        {
          listing_attributes: {
            some: {
              key: sizeSpecKey,
              value: 'Various',
            }
          }
        }
      ]
    });
    
    console.log(`📏 Size filter applied for ${category}: ${sizeValue} (also matching Various)`);
  } else {
    if (!where.AND) {
      where.AND = [];
    }
    where.AND.push({
      listing_attributes: {
        some: {
          key: 'size',
          value: { contains: sizeValue, mode: 'insensitive' },
        }
      }
    });
  }
}

      const orderBy: any = {};
      if (sortBy === 'price') {
        orderBy.price = sortOrder;
      } else if (sortBy === 'views') {
        orderBy.views = sortOrder;
      } else {
        orderBy.created_at = sortOrder;
      }

      console.log('📊 Prisma WHERE clause:', JSON.stringify(where, null, 2));

      const [listings, total] = await Promise.all([
        prisma.listings.findMany({
          where,
          skip,
          take: Number(limit),
          include: {
            images: {
              orderBy: { display_order: 'asc' },
              take: 1,
            },
           users: {
              select: {
                id: true,
                email: true,
                display_name: true,
                rating: true,
                is_verified: true,
              },
            },
            listing_attributes: true,
          },
          orderBy,
        }),
        prisma.listings.count({ where }),
      ]);

     console.log('📦 Found listings:', listings.length);
      console.log('📊 Total count:', total);

      // ✅ Sort verified sellers to top (within current sort order)
      const sortedListings = [...listings].sort((a, b) => {
        const aVerified = a.users?.is_verified ? 1 : 0;
        const bVerified = b.users?.is_verified ? 1 : 0;
        return bVerified - aVerified; // Verified first
      });

      res.json({
        listings: sortedListings,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          pages: Math.ceil(total / Number(limit)),
        },
        appliedFilters: {
          query,
          category,
          subcategory,
          minPrice,
          maxPrice,
          condition,
          brand,
          gender,
          dexterity,
          size,
          color,
          sortBy,
          sortOrder,
        },
      });
    } catch (error) {
      console.error('Search error:', error);
      res.status(500).json({ error: 'Search failed' });
    }
  }

  /**
   * Get available filter options for a category
   */
  static async getFilterOptions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { category } = req.params;

      const brands = await prisma.listings.findMany({
        where: { category, status: 'active' },
        select: { brand: true },
        distinct: ['brand'],
      });

      const attributes = await prisma.listing_attributes.findMany({
        where: {
          listings: {
            category,
            status: 'active',
          },
        },
        select: { key: true, value: true },
        distinct: ['key', 'value'],
      });

      const groupedAttributes: Record<string, string[]> = {};
      attributes.forEach(attr => {
        if (!groupedAttributes[attr.key]) {
          groupedAttributes[attr.key] = [];
        }
        if (attr.value && !groupedAttributes[attr.key].includes(attr.value)) {
          groupedAttributes[attr.key].push(attr.value);
        }
      });

      res.json({
        category,
        brands: brands
          .map(b => b.brand)
          .filter(Boolean)
          .sort(),
        attributes: groupedAttributes,
      });
    } catch (error) {
      console.error('Get filter options error:', error);
      res.status(500).json({ error: 'Failed to get filter options' });
    }
  }

  /**
   * Get sold items for a seller
   */
  static async getSoldItems(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      const { page = 1, limit = 20 } = req.query;

      const skip = (Number(page) - 1) * Number(limit);

      const [listings, total] = await Promise.all([
        prisma.listings.findMany({
          where: {
            seller_id: userId,
            status: 'sold',
          },
          skip,
          take: Number(limit),
          include: {
            images: {
              orderBy: { display_order: 'asc' },
              take: 1,
            },
            orders: {
              select: {
                amount: true,
                completed_at: true,
              },
            },
          },
          orderBy: { updated_at: 'desc' },
        }),
        prisma.listings.count({
          where: {
            seller_id: userId,
            status: 'sold',
          },
        }),
      ]);

      res.json({
        listings,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          pages: Math.ceil(total / Number(limit)),
        },
      });
    } catch (error) {
      console.error('Get sold items error:', error);
      res.status(500).json({ error: 'Failed to fetch sold items' });
    }
  }

  /**
   * Get price history for sold items (for anti-scam feature)
   */
  static async getPriceHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { category, brand, model } = req.query;

      const where: any = {
        status: 'sold',
      };

      if (category) where.category = category;
      if (brand) where.brand = { contains: brand as string, mode: 'insensitive' };
      if (model) where.model = { contains: model as string, mode: 'insensitive' };

      const soldItems = await prisma.listings.findMany({
        where,
        select: {
          title: true,
          brand: true,
          model: true,
          condition_overall: true,
          price: true,
          orders: {
            select: {
              amount: true,
              completed_at: true,
            },
            where: {
              status: 'completed',
            },
          },
        },
        orderBy: { updated_at: 'desc' },
        take: 50,
      });

      const prices = soldItems
        .filter(item => item.orders.length > 0)
        .map(item => Number(item.orders[0].amount));

      const stats = {
        count: prices.length,
        average: prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0,
        min: prices.length > 0 ? Math.min(...prices) : 0,
        max: prices.length > 0 ? Math.max(...prices) : 0,
      };

      res.json({
        soldItems: soldItems.slice(0, 10),
        stats,
        filters: { category, brand, model },
      });
    } catch (error) {
      console.error('Get price history error:', error);
      res.status(500).json({ error: 'Failed to fetch price history' });
    }
  }
}