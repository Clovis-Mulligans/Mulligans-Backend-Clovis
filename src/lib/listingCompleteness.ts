export function validateListingCompleteness(listing: any, imageCount: number): string | null {
  if (!listing.title || listing.title.length < 3) return 'title is required (min 3 characters)';
  if (!listing.description || listing.description.length < 10) return 'description is required (min 10 characters)';
  if (listing.price == null || parseFloat(listing.price) < 0.50) return 'price must be at least £0.50';
  if (!listing.category) return 'category is required';
  if (!listing.subcategory) return 'subcategory is required';
  if (!listing.location) return 'location is required';
  if (!listing.parcel_size) return 'parcel_size is required';
  if (listing.shipping_cost == null) return 'shipping_cost is required';
  if (listing.quantity == null || listing.quantity < 1) return 'quantity must be at least 1';
  if (imageCount < 1) return 'at least 1 image is required';
  return null;
}
