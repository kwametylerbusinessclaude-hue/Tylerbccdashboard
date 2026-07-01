// AskClaudeButton — opens a fresh Claude.ai conversation pre-loaded with
// the module's context and a suggested prompt, so the operator can pick up
// the thread outside the app without retyping.
//
// Minimal implementation authored 2026-07-01 to unblock the retrofit build
// after PlaybookGuide.jsx + SystemMap.jsx landed importing this component.
// Interface matches BOTH module usages:
//
//   SystemMap:
//     <AskClaudeButton
//       moduleLabel="System Map"
//       subject={`Wiki page: ${page.title} (${page.slug})`}
//       context={{...}}
//       suggestedPrompt="Help me work through what's on this BCC wiki page..."
//     />
//
//   PlaybookGuide:
//     <AskClaudeButton
//       moduleLabel="Playbook & Guide"
//       subject={heading + ' — ' + prompt.title}
//       suggestedPrompt={prompt.prompt}
//       label="Try in Claude"
//       variant="solid"
//     />
//
// Behavior: click assembles a plain-text message containing
//   [Module] moduleLabel · Subject: subject
//   [Context] pretty-printed JSON (if provided)
//   [Prompt]  suggestedPrompt
// puts it on the clipboard, and opens claude.ai in a new tab. The operator
// pastes into their existing Claude project (which has all the MCP tools).
// This is intentionally a hand-off — we don't try to auto-load context via
// URL params because Claude.ai's URL param interface for pre-filled prompts
// isn't stable across releases.

import { useState } from 'react';
import { MessageSquare, Check } from 'lucide-react';

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
  variant = "ghost", // "solid" | "ghost"
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
    // Open Claude in a new tab. window.open may pop-up-block on some browsers;
    // fall back to same-tab navigation only if pop-up blocked.
    try {
      const w = window.open('https://claude.ai/new', '_blank', 'noopener,noreferrer');
      if (!w) window.location.assign('https://claude.ai/new');
    } catch { window.location.assign('https://claude.ai/new'); }
  };

  const cls = variant === "solid"
    ? "if-button text-xs inline-flex items-center gap-1"
    : "if-button-ghost text-xs inline-flex items-center gap-1";

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cls}
      title="Copies context + prompt to your clipboard, then opens Claude.ai in a new tab. Paste into your BCC project."
    >
      {copied ? <Check size={14} /> : <MessageSquare size={14} />}
      {copied ? "Copied — paste in Claude" : label}
    </button>
  );
}
