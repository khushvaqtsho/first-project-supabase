import type { User } from "@supabase/supabase-js";
import { supabase } from "./supabase.js";

/** Sign in as a guest (Supabase anonymous sign-in). */
export async function signInAsGuest(): Promise<User> {
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  if (!data.user) throw new Error("Guest sign-in returned no user");
  return data.user;
}
