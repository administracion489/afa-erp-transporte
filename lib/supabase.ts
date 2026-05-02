import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;

// 🔒 Singleton sin cambiar imports
let supabaseInstance: ReturnType<typeof createClient> | null = null;

export const supabase =
  supabaseInstance ??
  (supabaseInstance = createClient(supabaseUrl, supabaseAnonKey));