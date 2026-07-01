// SectionHeader — icon + title + subtitle module header, inline-styled
// to match the fork's design tokens (matches BCCApp.jsx TOKENS palette).
//
// Usage: <SectionHeader title="..." subtitle="..." icon={LucideIconComponent} />

const S = {
  wrap:    { display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 4 },
  iconBox: {
    flexShrink: 0, width: 36, height: 36, borderRadius: 8,
    background: "#EFF6FF", color: "#2D7DD2",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  text:     { minWidth: 0, flex: 1 },
  title:    { fontSize: 17, fontWeight: 600, color: "#1B2B4B", lineHeight: 1.2, margin: 0 },
  subtitle: { fontSize: 12, color: "#64748B", marginTop: 2, lineHeight: 1.5 },
};

export default function SectionHeader({ title, subtitle, icon: Icon }) {
  return (
    <div style={S.wrap}>
      {Icon ? (
        <div style={S.iconBox}>
          <Icon size={18} />
        </div>
      ) : null}
      <div style={S.text}>
        <h2 style={S.title}>{title}</h2>
        {subtitle ? <p style={S.subtitle}>{subtitle}</p> : null}
      </div>
    </div>
  );
}
