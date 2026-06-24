import { useState } from "react";
import { updatePassword, validatePassword, signOut } from "../lib/auth.js";

/**
 * ForcePasswordChange — shown ONLY when public.users.must_change_password === true
 * for the currently authenticated user. Two fields, nothing else visible. No nav,
 * no module access, no escape. On success, AuthGate re-evaluates and renders the
 * dashboard.
 *
 * Built by Imaginary Farms LLC
 */
export default function ForcePasswordChange({ profile, onChanged }) {
  const [pwd1, setPwd1]   = useState("");
  const [pwd2, setPwd2]   = useState("");
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);

  const onSubmit = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    setError(null);

    const v = validatePassword(pwd1);
    if (v) { setError(v); return; }
    if (pwd1 !== pwd2) { setError("The two passwords don't match."); return; }

    setBusy(true);
    const { error: err } = await updatePassword(pwd1);
    setBusy(false);

    if (err) {
      setError(err.message || "Couldn't update password. Try again.");
      return;
    }
    // Tell AuthGate to re-fetch the profile and route to dashboard.
    if (typeof onChanged === "function") onChanged();
  };

  const onCancel = async () => {
    // The user can sign out to abandon the change. They'll still need to
    // change the password the next time they log in.
    setBusy(true);
    await signOut();
    setBusy(false);
  };

  return (
    <div style={styles.shell}>
      <div style={styles.card}>
        <div style={styles.headRow}>
          <div style={styles.icon}>🔒</div>
          <div>
            <div style={styles.title}>Set your new password</div>
            <div style={styles.sub}>
              You're using a temporary password. Set your own permanent password to continue.
            </div>
          </div>
        </div>

        {profile?.auth_email && (
          <div style={styles.accountRow}>
            Signed in as <strong>{profile.auth_email}</strong>
          </div>
        )}

        <form onSubmit={onSubmit} style={styles.form}>
          <label style={styles.label}>
            New password
            <input
              type="password"
              value={pwd1}
              onChange={(e) => setPwd1(e.target.value)}
              autoComplete="new-password"
              autoFocus
              style={styles.input}
              disabled={busy}
            />
          </label>

          <label style={styles.label}>
            Confirm new password
            <input
              type="password"
              value={pwd2}
              onChange={(e) => setPwd2(e.target.value)}
              autoComplete="new-password"
              style={styles.input}
              disabled={busy}
            />
          </label>

          <div style={styles.rules}>
            Must be at least 12 characters and include uppercase, lowercase, and a number.
          </div>

          {error && <div style={styles.error}>{error}</div>}

          <button type="submit" disabled={busy} style={styles.primaryBtn}>
            {busy ? "Saving…" : "Set new password and continue"}
          </button>

          <button type="button" onClick={onCancel} disabled={busy} style={styles.secondaryBtn}>
            Cancel and sign out
          </button>
        </form>
      </div>
    </div>
  );
}

const TOKENS = {
  navy: "#1B2B4B", blue: "#2D7DD2", slate200: "#E2E8F0", slate400: "#94A3B8",
  slate500: "#64748B", slate700: "#334155", slate900: "#0F172A",
  white: "#FFFFFF", red: "#EF4444", redLt: "#FEE2E2",
  slate50: "#F8FAFC", amberLt: "#FEF3C7",
};

const styles = {
  shell: {
    minHeight: "100vh", display: "flex",
    alignItems: "center", justifyContent: "center",
    background: `linear-gradient(135deg, ${TOKENS.navy} 0%, #0F172A 100%)`,
    padding: 24,
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },
  card: {
    width: "100%", maxWidth: 460,
    background: TOKENS.white, borderRadius: 14,
    boxShadow: "0 12px 40px rgba(0,0,0,0.35)", padding: "28px 28px 22px",
  },
  headRow: { display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 18 },
  icon: {
    width: 40, height: 40, borderRadius: 10,
    background: TOKENS.amberLt, color: "#92400E",
    display: "grid", placeItems: "center", fontSize: 20, flexShrink: 0,
  },
  title: { fontSize: 16, fontWeight: 700, color: TOKENS.slate900 },
  sub: { fontSize: 12, color: TOKENS.slate500, marginTop: 4, lineHeight: 1.5 },
  accountRow: {
    fontSize: 12, color: TOKENS.slate500,
    background: TOKENS.slate50,
    border: `1px solid ${TOKENS.slate200}`,
    padding: "8px 11px", borderRadius: 8, marginBottom: 14,
  },
  form: { display: "flex", flexDirection: "column", gap: 14 },
  label: { display: "flex", flexDirection: "column", gap: 6, fontSize: 12, fontWeight: 600, color: TOKENS.slate700 },
  input: {
    padding: "10px 12px", fontSize: 14,
    border: `1px solid ${TOKENS.slate200}`, borderRadius: 8,
    outline: "none", color: TOKENS.slate900,
  },
  rules: { fontSize: 11, color: TOKENS.slate500, marginTop: -4 },
  primaryBtn: {
    padding: "11px 14px", fontSize: 14, fontWeight: 600,
    background: TOKENS.blue, color: TOKENS.white,
    border: "none", borderRadius: 8, cursor: "pointer", marginTop: 4,
  },
  secondaryBtn: {
    padding: "8px 14px", fontSize: 12, fontWeight: 500,
    background: TOKENS.white, color: TOKENS.slate500,
    border: `1px solid ${TOKENS.slate200}`, borderRadius: 8, cursor: "pointer",
  },
  error: {
    background: TOKENS.redLt, color: "#991B1B",
    border: "1px solid #FCA5A5",
    borderRadius: 8, padding: "9px 11px", fontSize: 12,
  },
};
