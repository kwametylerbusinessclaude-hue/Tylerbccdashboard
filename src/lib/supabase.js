import { createClient } from '@supabase/supabase-js'

// Vite inlines `import.meta.env.VITE_*` at build time. Vercel env values
// sometimes carry a stray trailing newline from the dashboard textarea —
// .trim() defuses that class of bug (we hit it 2026-06-18 when a trailing
// \n on VITE_AGENCY_ID broke every .eq("agency_id", AGENCY_ID) query).
const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim()
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim()

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variables. Check your .env file or Vercel environment settings.')
}

// Null guard — supabase will be null if env vars are missing
// All modules must guard against null supabase before calling .from()
export const supabase = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null

// Agency ID — set this to your Supabase agency row ID after running migration 004
// Find it with: SELECT id FROM agency LIMIT 1;
export const AGENCY_ID = (import.meta.env.VITE_AGENCY_ID || '').trim() || null
