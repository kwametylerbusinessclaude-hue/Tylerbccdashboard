// PrintButton — triggers browser print for the current view, inline-styled.
// The existing Financials.jsx "Print Full Report" flow is untouched.

import { Printer } from 'lucide-react';

const BTN = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "5px 10px",
  borderRadius: 6,
  fontSize: 12, fontWeight: 500,
  color: "#334155", background: "#FFFFFF", border: "1px solid #E2E8F0",
  cursor: "pointer",
  transition: "background 0.15s, border-color 0.15s",
};

export default function PrintButton({ title, label = "Print" }) {
  const handleClick = () => {
    if (typeof window === "undefined") return;
    const prev = document.title;
    if (title) document.title = title;
    try {
      window.print();
    } finally {
      setTimeout(() => { document.title = prev; }, 500);
    }
  };
  return (
    <button type="button" onClick={handleClick} style={BTN} title={title || "Print"}>
      <Printer size={13} /> {label}
    </button>
  );
}
