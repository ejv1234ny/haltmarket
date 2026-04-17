export const env = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? 'http://127.0.0.1:3000',
};

// When Supabase credentials are absent (local dev without a project yet, or
// CI), the UI runs against mocked data. The flag lets components branch
// without swallowing real errors once credentials land.
export const supabaseConfigured =
  env.NEXT_PUBLIC_SUPABASE_URL.length > 0 && env.NEXT_PUBLIC_SUPABASE_ANON_KEY.length > 0;
