import { useState } from "react";
import { signIn, sendPasswordReset } from "../lib/auth.js";

/**
 * Login screen for the BCC.
 * Two fields (email, password) + Log in button, with a "Forgot password?" toggle
 * that swaps to the email-only reset request form. No registration field — accounts
 * are created admin-side only.
 *
 * Built by Imaginary Farms LLC
 */
export default function Login() {
  const [mode, setMode]       = useState("login"); // "login" | "forgot"
  const [email, setEmail]     = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);
  const [info,  setInfo]      = useState(null);

  const onLogin = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    setError(null); setInfo(null);
    if (!email || !password) { setError("Email and password are required."); return; }
    setBusy(true);
    const { error: err } = await signIn(email, password);
    setBusy(false);
    if (err) setError(err.message || "Sign-in failed. Check your email and password.");
    // On success: the auth state change listener in AuthGate will swap the screen.
  };

  const onForgot = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    setError(null); setInfo(null);
    if (!email) { setError("Enter your email so we can send a reset link."); return; }
    setBusy(true);
    const { error: err } = await sendPasswordReset(email);
    setBusy(false);
    if (err) setError(err.message || "Could not send reset email.");
    else setInfo("If that email is registered, a password-reset link is on its way. Check your inbox (and spam folder).");
  };

  return (
    <div style={styles.shell}>
      <div style={styles.card}>
        <div style={styles.brandRow}>
          <div style={styles.logoSquare}>⚡</div>
          <div>
            <div style={styles.brandTitle}>Business Command Center</div>
            <div style={styles.brandSub}>{mode === "login" ? "Sign in to your account" : "Reset your password"}</div>
          </div>
        </div>

        <form onSubmit={mode === "login" ? onLogin : onForgot} style={styles.form}>
          <label style={styles.label}>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoFocus
              style={styles.input}
              placeholder="you@gmail.com"
              disabled={busy}
            />
          </label>

          {mode === "login" && (
            <label style={styles.label}>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                style={styles.input}
                placeholder="Enter your password"
                disabled={busy}
              />
            </label>
          )}

          {error && <div style={styles.error}>{error}</div>}
          {info  && <div style={styles.info}>{info}</div>}

          <button type="submit" disabled={busy} style={styles.primaryBtn}>
            {busy ? "Working…" : (mode === "login" ? "Log in" : "Send reset link")}
          </button>

          <div style={styles.linkRow}>
            {mode === "login" ? (
              <button
                type="button"
                onClick={() => { setMode("forgot"); setError(null); setInfo(null); }}
                style={styles.linkBtn}
              >Forgot password?</button>
            ) : (
              <button
                type="button"
                onClick={() => { setMode("login"); setError(null); setInfo(null); }}
                style={styles.linkBtn}
              >Back to sign in</button>
            )}
          </div>
        </form>

        <div style={styles.footer}>
          Built by Imaginary Farms LLC &nbsp;·&nbsp; The Claude Whisperer
        </div>
      </div>
    </div>
  );
}

const TOKENS = {
  navy: "#1B2B4B", blue: "#2D7DD2", slate200: "#E2E8F0", slate400: "#94A3B8",
  slate500: "#64748B", slate700: "#334155", slate900: "#0F172A",
  white: "#FFFFFF", red: "#EF4444", redLt: "#FEE2E2",
  green: "#10B981", greenLt: "#D1FAE5",
};

const styles = {
  shell: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: `linear-gradient(135deg, ${TOKENS.navy} 0%, #0F172A 100%)`,
    padding: 24,
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },
  card: {
    width: "100%", maxWidth: 420,
    background: TOKENS.white,
    borderRadius: 14,
    boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
    padding: "28px 28px 22px",
  },
  brandRow: { display: "flex", alignItems: "center", gap: 12, marginBottom: 22 },
  logoSquare: {
    width: 40, height: 40, borderRadius: 10,
    background: TOKENS.navy, color: TOKENS.white,
    display: "grid", placeItems: "center", fontSize: 20,
  },
  brandTitle: { fontSize: 16, fontWeight: 700, color: TOKENS.slate900 },
  brandSub:   { fontSize: 12, color: TOKENS.slate500, marginTop: 2 },
  form: { display: "flex", flexDirection: "column", gap: 14 },
  label: { display: "flex", flexDirection: "column", gap: 6, fontSize: 12, fontWeight: 600, color: TOKENS.slate700 },
  input: {
    padding: "10px 12px",
    fontSize: 14,
    border: `1px solid ${TOKENS.slate200}`,
    borderRadius: 8,
    outline: "none",
    color: TOKENS.slate900,
  },
  primaryBtn: {
    padding: "11px 14px",
    fontSize: 14, fontWeight: 600,
    background: TOKENS.blue, color: TOKENS.white,
    border: "none", borderRadius: 8, cursor: "pointer",
    marginTop: 4,
  },
  linkRow: { textAlign: "center", marginTop: 4 },
  linkBtn: {
    background: "transparent", border: "none",
    color: TOKENS.blue, fontSize: 12, cursor: "pointer",
    textDecoration: "underline", padding: 0,
  },
  error: {
    background: TOKENS.redLt, color: "#991B1B",
    border: "1px solid #FCA5A5",
    borderRadius: 8, padding: "9px 11px", fontSize: 12,
  },
  info: {
    background: TOKENS.greenLt, color: "#065F46",
    border: "1px solid #6EE7B7",
    borderRadius: 8, padding: "9px 11px", fontSize: 12,
  },
  footer: { marginTop: 18, textAlign: "center", fontSize: 10, color: TOKENS.slate400 },
};
