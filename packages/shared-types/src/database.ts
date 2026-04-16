// Generated Supabase types will be emitted here by `supabase gen types typescript`.
// Until Phase 1 creates the first migration, export an empty placeholder so downstream
// packages can import the shape without build errors.

export type Json = string | number | boolean | null | { [k: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}
