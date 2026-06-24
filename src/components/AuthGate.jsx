import { useEffect, useState, createContext, useContext } from "react";
import { supabase } from "../lib/supabase.js";
import { loadProfile, stampLastLogin, isRecoveryCallback, clearAuthHash } from "../lib/auth.js";
import Login from "./Login.jsx";
import ForcePasswordChange from "./ForcePasswordChange.jsx";
import ResetPasswordCallback from "./ResetPasswordCallback.jsx";

/**
 * AuthGate — wraps the entire app and routes between:
 *   1. ResetPasswordCallback  — when the URL has #type=recovery (forgot-password email)
 *   2. Login                  — when there is no Supabase session
 *   3. ForcePasswordChange    — when the user's public.users.must_change_password = true
 *   4. children (BCCApp)      — when fully authenticated and password is permanent
 *
 * The current user profile is exposed via the AuthUserContext so BCCApp can show
 * the real name/email/role in the header and wire up the "Sign out" menu item.
 *
 * Built by Imaginary Farms LLC
 */

export const AuthUserContext = createContext(null);
export const useAuthUser = () => useContext(AuthUserContext);

export default function AuthGate({ children }) {
  // recovery > loading > none > needs_change > ready
  const [phase, setPhase] = useState(isRecoveryCallback() ? "recovery" : "loading");
  const [profile, setProfile] = useState(null);

  // Initial session load + profile fetch
  useEffect(() => {
    if (phase === "recovery") return; // don't auto-route during recovery
    if (!supabase) {
      // Without supabase the dashboard cannot function at all. Surface this clearly.
      setPhase("none");
      return;
    }
    let cancelled = false;

    async function evaluate() {
      const p = await loadProfile();
      if (cancelled) return;
      if (!p) {
        setProfile(null);
        setPhase("none");
        return;
      }
      // Stamp last_login best-effort
      stampLastLogin(p.auth_user_id).catch(() => {});
      setProfile(p);
      if (p._missing_profile) {
        // Authenticated but no public.users row — treat as a misconfiguration.
        setPhase("missing_profile");
      } else if (p.must_change_password) {
        setPhase("needs_change");
      } else if (p.is_active === false) {
        setPhase("deactivated");
      } else {
        setPhase("ready");
      }
    }

    evaluate();

    // React to auth state changes (login, logout, token refresh).
    const { data: sub } = supabase.auth.onAuthStateChange((event, _session) => {
      // PASSWORD_RECOVERY arrives after the recovery URL hash is consumed
      if (event === "PASSWORD_RECOVERY") {
        setPhase("recovery");
        return;
      }
      if (event === "SIGNED_OUT") {
        setProfile(null);
        setPhase("none");
        return;
      }
      // SIGNED_IN, TOKEN_REFRESHED, USER_UPDATED — re-evaluate.
      evaluate();
    });

    return () => { cancelled = true; sub?.subscription?.unsubscribe?.(); };
  }, []);

  if (phase === "loading") return <FullPageMessage emoji="…" title="Loading" />;

  if (phase === "recovery") {
    return (
      <ResetPasswordCallback
        onComplete={() => { clearAuthHash(); setPhase("none"); }}
      />
    );
  }

  if (phase === "none") return <Login />;

  if (phase === "needs_change") {
    return (
      <ForcePasswordChange
        profile={profile}
        onChanged={async () => {
          const p = await loadProfile();
          setProfile(p);
          setPhase(p && !p.must_change_password ? "ready" : "needs_change");
        }}
      />
    );
  }

  if (phase === "missing_profile") {
    return (
      <FullPageMessage
        emoji="⚠️"
        title="Your account isn't fully provisioned"
        body={`We signed you in as ${profile?.auth_email}, but no profile row exists in public.users for this account. Ask the agency owner to set this up. Click the button to sign out.`}
        action={async () => { await supabase.auth.signOut(); }}
        actionLabel="Sign out"
      />
    );
  }

  if (phase === "deactivated") {
    return (
      <FullPageMessage
        emoji="🚫"
        title="This account is deactivated"
        body={`The account for ${profile?.auth_email} has been deactivated. Contact the agency owner if you believe this is an error.`}
        action={async () => { await supabase.auth.signOut(); }}
        actionLabel="Sign out"
      />
    );
  }

  // phase === "ready"
  return (
    <AuthUserContext.Provider value={profile}>
      {children}
    </AuthUserContext.Provider>
  );
}

function FullPageMessage({ emoji, title, body, action, actionLabel }) {
  return (
    <div style={fpStyles.shell}>
      <div style={fpStyles.card}>
        <div style={{ fontSize: 38, marginBottom: 10 }}>{emoji}</div>
        <div style={fpStyles.title}>{title}</div>
        {body && <div style={fpStyles.body}>{body}</div>}
        {action && (
          <button style={fpStyles.btn} onClick={action}>{actionLabel || "Continue"}</button>
        )}
      </div>
    </div>
  );
}

const fpStyles = {
  shell: {
    minHeight: "100vh", display: "flex",
    alignItems: "center", justifyContent: "center",
    background: "linear-gradient(135deg, #1B2B4B 0%, #0F172A 100%)",
    padding: 24, textAlign: "center",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    color: "#FFFFFF",
  },
  card: {
    background: "#FFFFFF", color: "#0F172A",
    borderRadius: 14, padding: "28px 32px",
    width: "100%", maxWidth: 420,
    boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
  },
  title: { fontSize: 16, fontWeight: 700 },
  body: { fontSize: 13, color: "#64748B", marginTop: 8, lineHeight: 1.55 },
  btn: {
    marginTop: 16, padding: "9px 16px",
    fontSize: 13, fontWeight: 600,
    background: "#2D7DD2", color: "#FFFFFF",
    border: "none", borderRadius: 8, cursor: "pointer",
  },
};
