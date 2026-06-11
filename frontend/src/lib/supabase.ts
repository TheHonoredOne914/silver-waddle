import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // In development: warn loudly. In production: throw so the build
  // surfaces the misconfiguration immediately rather than silently
  // failing auth at runtime.
  const msg =
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. " +
    "Copy frontend/.env.example to frontend/.env and fill in your Supabase credentials.";
  if (import.meta.env.PROD) {
    throw new Error(msg);
  } else {
    console.error("[BestDel]", msg);
  }
}

export const supabase = createClient(
  supabaseUrl ?? "http://localhost:54321",
  supabaseAnonKey ?? "missing-anon-key",
);
