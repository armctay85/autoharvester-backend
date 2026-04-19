// Tier + status unions are kept in sync with the v2 schema enums in
// `db/schema.ts`. Whenever you add an enum value there, widen these too.
export type SubscriptionTier =
  | 'free'
  | 'pro'
  | 'dealer'
  | 'enterprise'
  | 'watchlist'
  | 'dealer_edge'
  | 'inventory_iq'
  | 'group';

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'cancelled'
  | 'past_due'
  | 'paused';

export type ListingSource =
  | 'carsales'
  | 'gumtree'
  | 'facebook'
  | 'drive'
  | 'dealer_feed'
  | 'auction_pickles'
  | 'auction_manheim'
  | 'auction_grays'
  | 'auction_government'
  | 'user_contribution'
  | 'partner_feed'
  | 'ppsr_reference';

export interface User {
  id: string;
  email: string;
  password_hash: string;
  first_name: string;
  last_name: string;
  subscription_tier: SubscriptionTier;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: SubscriptionStatus | null;
  subscription_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

export interface CarListing {
  id: string;
  external_id: string;
  source: ListingSource;
  make: string;
  model: string;
  year: number;
  price: number | null;
  price_history: PriceHistoryEntry[];
  sold_price: number | null;
  sold_date: Date | null;
  location: string;
  odometer: number | null;
  transmission: string | null;
  fuel_type: string | null;
  body_type: string | null;
  listing_url: string;
  images: string[];
  first_seen_at: Date;
  last_seen_at: Date;
  removed_at: Date | null;
  is_sold: boolean;
  is_active: boolean;
}

export interface PriceHistoryEntry {
  date: string;
  price: number;
}

export interface PriceAlert {
  id: string;
  user_id: string;
  make: string | null;
  model: string | null;
  year_min: number | null;
  year_max: number | null;
  price_max: number | null;
  location: string | null;
  is_active: boolean;
  created_at: Date;
}

export interface SavedSearch {
  id: string;
  user_id: string;
  search_params: SearchParams;
  name: string;
  created_at: Date;
}

export interface SearchParams {
  make?: string;
  model?: string;
  year_min?: number;
  year_max?: number;
  price_min?: number;
  price_max?: number;
  location?: string;
  sold_only?: boolean;
}

export interface ApiUsage {
  id: string;
  user_id: string | null;
  endpoint: string;
  timestamp: Date;
  ip_address: string;
}

export interface AuthenticatedRequest extends Request {
  user?: User;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  description: string;
  price: number;
  interval: 'month' | 'year';
  tier: 'pro' | 'dealer';
  features: string[];
}

export interface JwtPayload {
  userId: string;
  email: string;
  tier: string;
}
