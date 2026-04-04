import React from "react";

interface StepBadgeProps {
  step: number;
  total?: number;
}

export const StepBadge: React.FC<StepBadgeProps> = ({ step, total = 8 }) => {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          fontSize: 16,
          fontWeight: 700,
        }}
      >
        {step}
      </div>
      <span
        style={{
          color: "rgba(255,255,255,0.5)",
          fontSize: 14,
          fontWeight: 500,
          letterSpacing: 2,
          textTransform: "uppercase",
        }}
      >
        STEP {step} / {total}
      </span>
    </div>
  );
};
