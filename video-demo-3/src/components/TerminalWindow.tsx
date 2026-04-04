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
        borderRadius: 14,
        overflow: "hidden",
        boxShadow:
          "0 30px 70px rgba(0,0,0,0.6), 0 0 1px rgba(255,255,255,0.1)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {/* Title bar */}
      <div
        style={{
          height: 42,
          background: "linear-gradient(180deg, #3a3a4a, #2d2d3a)",
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 8,
        }}
      >
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: "#ff5f57",
          }}
        />
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: "#ffbd2e",
          }}
        />
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: "#28c840",
          }}
        />
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
          background: "#1a1a2a",
          padding: "22px 26px",
          minHeight: 200,
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: 16,
          lineHeight: 1.7,
          color: "#e0e0e0",
        }}
      >
        {children}
      </div>
    </div>
  );
};
