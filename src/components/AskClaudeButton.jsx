// AskClaudeButton — copies module context + prompt to clipboard, then opens
// claude.ai in a new tab. Inline-styled to match the fork.
//
// Two variants:
//   variant="ghost" (default) — subtle bordered button
//   variant="solid"           — filled blue button (used by PlaybookGuide's "Try in Claude")

import { useState } from 'react';
import { MessageSquare, Check } from 'lucide-react';

const BASE = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "5px 10px",
  borderRadius: 6,
  fontSize: 12, fontWeight: 500,
  cursor: "pointer",
  transition: "background 0.15s, border-color 0.15s",
  border: "1px solid transparent",
  whiteSpace: "nowrap",
};
const GHOST = { ...BASE, color: "#334155", background: "#FFFFFF", borderColor: "#E2E8F0" };
const SOLID = { ...BASE, color: "#FFFFFF", background: "#2D7DD2", borderColor: "#2D7DD2" };
const COPIED_TINT = { background: "#D1FAE5", borderColor: "#10B981", color: "#065F46" };

function buildHandoffText({ moduleLabel, subject, context, suggestedPrompt }) {
  const parts = [];
  if (moduleLabel || subject) {
    const header = [moduleLabel, subject].filter(Boolean).join(' · ');
    parts.push(`[BCC · ${header}]`);
  }
  if (context && typeof context === 'object') {
    let pretty;
    try { pretty = JSON.stringify(context, null, 2); } catch { pretty = String(context); }
    parts.push(`Context:\n${pretty}`);
  }
  if (suggestedPrompt) parts.push(suggestedPrompt);
  return parts.join('\n\n');
}

export default function AskClaudeButton({
  moduleLabel,
  subject,
  context,
  suggestedPrompt,
  label = "Ask Claude",
  variant = "ghost",
}) {
  const [copied, setCopied] = useState(false);

  const handleClick = async () => {
    const text = buildHandoffText({ moduleLabel, subject, context, suggestedPrompt });
    let clipboardOk = false;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        clipboardOk = true;
      }
    } catch { clipboardOk = false; }
    if (clipboardOk) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
    try {
      const w = window.open('https://claude.ai/new', '_blank', 'noopener,noreferrer');
      if (!w) window.location.assign('https://claude.ai/new');
    } catch { window.location.assign('https://claude.ai/new'); }
  };

  let style = variant === "solid" ? SOLID : GHOST;
  if (copied) style = { ...style, ...COPIED_TINT };

  return (
    <button
      type="button"
      onClick={handleClick}
      style={style}
      title="Copies context + prompt to your clipboard, then opens Claude.ai in a new tab. Paste into your BCC project."
    >
      {copied ? <Check size={13} /> : <MessageSquare size={13} />}
      {copied ? "Copied — paste in Claude" : label}
    </button>
  );
}
