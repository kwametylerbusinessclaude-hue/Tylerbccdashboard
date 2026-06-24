import { useState } from "react";
import { updatePassword, validatePassword, signOut, clearAuthHash } from "../lib/auth.js";

/**
 * ResetPasswordCallback — landing page after a user clicks the "reset password"
 * link in their email. Supabase has already exchanged the recovery token for a
 * temporary session by the time this renders. We collect the new password,
 * call updatePassword, then route the user back to login (clean slate).
 *
 * Triggered by AuthGate when URL hash contains type=recovery.
 *
 * Built by Imaginary Farms LLC
 */
export default function ResetPasswordCallback({ onComplete }) {
  const [pwd1, setPwd1]   = useState("");
  const [pwd2, setPwd2]   = useState("");
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone]   = useState(false);

  const onSubmit = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    setError(null);

    const v = validatePassword(pwd1);
    if (v) { setError(v); return; }
    if (pwd1 !== pwd2) { setError("The two passwords don't match."); return; }

    setBusy(true);
    const { error: err } = await updatePassword(pwd1);
    if (err) {
      setBusy(false);
      setError(err.message || "Couldn't update password. The reset link may have expired — request a new one from the login screen.");
      return;
    }

    // Clear the URL fragment so a refresh doesn't bounce back to this screen
    clearAuthHash();
    // Sign the user out — the next sign-in confirms the new password works.
    await signOut();
    setBusy(false);
    setDone(true);
    if (typeof onComplete === "function") setTimeout(onComplete, 1200);
  };

  if (done) {
    return (
      <div style={styles.shell}>
        <div style={styles.card}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
          <div style={styles.title}>Password updated</div>
          <div style={styles.sub}>Taking you back to the login screen…</div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.shell}>
      <div style={styles.card}>
        <div style={styles.headRow}>
          <div style={styles.icon}>🔑</div>
          <div>
            <div style={styles.title}>Choose a new password</div>
            <div style={styles.sub}>You're resetting the password for your BCC account.</div>
          </div>
        </div>

        <form onSubmit={onSubmit} style={styles.form}>
          <label style={styles.label}>
            New password
            <input
              type="password" value={pwd1}
              onChange={(e) => setPwd1(e.target.value)}
              autoComplete="new-password" autoFocus
              style={styles.input} disabled={busy}
            />
          </label>

          <label style={styles.label}>
            Confirm new password
            <input
              type="password" value={pwd2}
              onChange={(e) => setPwd2(e.target.value)}
              autoComplete="new-password"
              style={styles.input} disabled={busy}
            />
          </label>

          <div style={styles.rules}>
            Must be at least 12 characters and include uppercase, lowercase, and a number.
          </div>

          {error && <div style={styles.error}>{error}</div>}

          <button type="submit" disabled={busy} style={styles.primaryBtn}>
            {busy ? "Saving…" : "Update password"}
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
  slate50: "#F8FAFC", blueLt: "#EFF6FF",
};

const styles = {
  shell: {
    minHeight: "100vh", display: "flex",
    alignItems: "center", justifyContent: "center",
    background: `linear-gradient(135deg, ${TOKENS.navy} 0%, #0F172A 100%)`,
    padding: 24, textAlign: "center",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },
  card: {
    width: "100%", maxWidth: 460,
    background: TOKENS.white, borderRadius: 14,
    boxShadow: "0 12px 40px rgba(0,0,0,0.35)", padding: "28px 28px 22px",
    textAlign: "left",
  },
  headRow: { display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 18 },
  icon: {
    width: 40, height: 40, borderRadius: 10,
    background: TOKENS.blueLt, color: TOKENS.blue,
    display: "grid", placeItems: "center", fontSize: 20, flexShrink: 0,
  },
  title: { fontSize: 16, fontWeight: 700, color: TOKENS.slate900 },
  sub:   { fontSize: 12, color: TOKENS.slate500, marginTop: 4, lineHeight: 1.5 },
  form:  { display: "flex", flexDirection: "column", gap: 14 },
  label: { display: "flex", flexDirection: "column", gap: 6, fontSize: 12, fontWeight: 600, color: TOKENS.slate700 },
  input: { padding: "10px 12px", fontSize: 14, border: `1px solid ${TOKENS.slate200}`, borderRadius: 8, outline: "none", color: TOKENS.slate900 },
  rules: { fontSize: 11, color: TOKENS.slate500, marginTop: -4 },
  primaryBtn: { padding: "11px 14px", fontSize: 14, fontWeight: 600, background: TOKENS.blue, color: TOKENS.white, border: "none", borderRadius: 8, cursor: "pointer", marginTop: 4 },
  error: { background: TOKENS.redLt, color: "#991B1B", border: "1px solid #FCA5A5", borderRadius: 8, padding: "9px 11px", fontSize: 12 },
};
