import { supabase } from "./supabase.js";

/**
 * Auth helpers for the BCC login flow.
 *
 * Built by Imaginary Farms LLC — The Claude Whisperer
 * imaginary-farms.com
 *
 * Design notes:
 * - Passwords are NEVER touched in plaintext by this module. We hand them to
 *   supabase.auth.signInWithPassword / signUp / updateUser which forward them
 *   over TLS to GoTrue, where they are bcrypt-hashed before persistence.
 * - The must_change_password flag lives on public.users (not in auth.user_metadata)
 *   so it is tamper-resistant: the user cannot flip it themselves via a JS
 *   session token. RLS allows them to clear it only via the dedicated update
 *   policy, which the change-password flow uses after a successful auth update.
 */

const minPasswordLength = 12;

export function validatePassword(pwd) {
  if (typeof pwd !== "string") return "Password is required.";
  if (pwd.length < minPasswordLength) return `Password must be at least ${minPasswordLength} characters.`;
  if (!/[A-Z]/.test(pwd)) return "Password must include an uppercase letter.";
  if (!/[a-z]/.test(pwd)) return "Password must include a lowercase letter.";
  if (!/\d/.test(pwd))   return "Password must include a number.";
  return null;
}

export async function signIn(email, password) {
  if (!supabase) return { error: { message: "Supabase client not configured." } };
  const { data, error } = await supabase.auth.signInWithPassword({
    email: (email || "").trim().toLowerCase(),
    password: password || "",
  });
  return { data, error };
}

export async function signOut() {
  if (!supabase) return { error: { message: "Supabase client not configured." } };
  return supabase.auth.signOut();
}

export async function sendPasswordReset(email) {
  if (!supabase) return { error: { message: "Supabase client not configured." } };
  // The recovery email links back to the app with #type=recovery in the URL hash;
  // AuthGate detects that and renders the ResetPasswordCallback screen.
  const redirectTo = window.location.origin + window.location.pathname;
  return supabase.auth.resetPasswordForEmail((email || "").trim().toLowerCase(), { redirectTo });
}

/**
 * Update the current authenticated user's password.
 * After success, clears the must_change_password flag on public.users.
 */
export async function updatePassword(newPassword) {
  if (!supabase) return { error: { message: "Supabase client not configured." } };
  const validationError = validatePassword(newPassword);
  if (validationError) return { error: { message: validationError } };

  const { data, error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { error };

  // Clear the flag — RLS policy users_self_clear_mcp scopes this to the
  // currently-logged-in user's row, so no agency_id filter is needed.
  const authUserId = data?.user?.id;
  if (authUserId) {
    await supabase
      .from("users")
      .update({ must_change_password: false, updated_at: new Date().toISOString() })
      .eq("auth_user_id", authUserId);
  }
  return { data };
}

/**
 * Fetch the public.users profile row for the currently authenticated user.
 * Returns null if no session or no provisioned profile.
 */
export async function loadProfile() {
  if (!supabase) return null;
  const { data: sess } = await supabase.auth.getSession();
  const authUser = sess?.session?.user;
  if (!authUser) return null;

  const { data: profile, error } = await supabase
    .from("users")
    .select("id, agency_id, email, full_name, role, must_change_password, is_active, last_login")
    .eq("auth_user_id", authUser.id)
    .maybeSingle();

  if (error) {
    console.error("loadProfile error:", error);
    return null;
  }
  return profile
    ? { ...profile, auth_user_id: authUser.id, auth_email: authUser.email }
    : { auth_user_id: authUser.id, auth_email: authUser.email, _missing_profile: true };
}

/**
 * Stamps last_login on the public.users row. Safe to call after every sign-in.
 */
export async function stampLastLogin(authUserId) {
  if (!supabase || !authUserId) return;
  await supabase
    .from("users")
    .update({ last_login: new Date().toISOString() })
    .eq("auth_user_id", authUserId);
}

/**
 * Detect whether the current URL is a password-recovery callback.
 * Supabase sends users to redirectTo with #access_token=...&type=recovery&...
 */
export function isRecoveryCallback() {
  if (typeof window === "undefined") return false;
  const hash = window.location.hash || "";
  if (!hash.includes("type=recovery")) return false;
  return true;
}

/**
 * Strip the auth fragment from the URL after we've consumed it,
 * so the page doesn't get stuck in recovery mode on a refresh.
 */
export function clearAuthHash() {
  if (typeof window === "undefined") return;
  if (window.history && window.history.replaceState) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}
