import React from "react";

interface TerminalWindowProps {
  title?: string;
  children: React.ReactNode;
  width?: number;
}

export const TerminalWindow: React.FC<TerminalWindowProps> = ({
  title = "Terminal",
  children,
  width = 900,
}) => {
  return (
    <div
      style={{
        width,
        borderRadius: 12,
        overflow: "hidden",
        boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {/* Title bar */}
      <div
        style={{
          height: 40,
          background: "#2d2d3a",
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 8,
        }}
      >
        <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#ff5f57" }} />
        <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#ffbd2e" }} />
        <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#28c840" }} />
        <span
          style={{
            flex: 1,
            textAlign: "center",
            color: "rgba(255,255,255,0.4)",
            fontSize: 13,
            fontFamily: "monospace",
          }}
        >
          {title}
        </span>
      </div>
      {/* Content */}
      <div
        style={{
          background: "#1e1e2e",
          padding: "20px 24px",
          minHeight: 200,
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: 16,
          lineHeight: 1.6,
          color: "#e0e0e0",
        }}
      >
        {children}
      </div>
    </div>
  );
};
