import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

interface SceneContainerProps {
  children: React.ReactNode;
  durationInFrames: number;
  bgGradient?: string;
  stepNumber?: number;
  stepTotal?: number;
  heading?: string;
  caption?: string;
}

export const SceneContainer: React.FC<SceneContainerProps> = ({
  children,
  durationInFrames,
  bgGradient,
  stepNumber,
  stepTotal = 8,
  heading,
  caption,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entranceOpacity = spring({
    frame,
    fps,
    config: { damping: 12, stiffness: 80 },
  });

  const exitOpacity = interpolate(
    frame,
    [durationInFrames - 15, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const opacity = Math.min(entranceOpacity, exitOpacity);

  const background =
    bgGradient ||
    "radial-gradient(ellipse at 50% 50%, #1a1a2e 0%, #0d0d1a 50%, #0a0a0f 100%)";

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        background,
        opacity,
        position: "relative",
        fontFamily: "Inter, system-ui, -apple-system, sans-serif",
        overflow: "hidden",
      }}
    >
      {/* Progress bar at top */}
      {stepNumber !== undefined && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            background: "rgba(255,255,255,0.05)",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${(stepNumber / stepTotal) * 100}%`,
              background: "linear-gradient(90deg, #6366f1, #8b5cf6, #a78bfa)",
              borderRadius: "0 2px 2px 0",
            }}
          />
        </div>
      )}

      {stepNumber !== undefined && (
        <div
          style={{
            position: "absolute",
            top: 28,
            left: 48,
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
              boxShadow: "0 0 20px rgba(99,102,241,0.4)",
            }}
          >
            {stepNumber}
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
            STEP {stepNumber} / {stepTotal}
          </span>
        </div>
      )}

      {heading && (
        <div
          style={{
            position: "absolute",
            top: 32,
            right: 48,
            color: "rgba(255,255,255,0.85)",
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: 0.5,
          }}
        >
          {heading}
        </div>
      )}

      {children}

      {caption && (
        <div
          style={{
            position: "absolute",
            bottom: 44,
            left: 80,
            right: 80,
            textAlign: "center",
            color: "rgba(255,255,255,0.55)",
            fontSize: 21,
            fontWeight: 400,
            letterSpacing: 0.3,
            lineHeight: 1.5,
          }}
        >
          {caption}
        </div>
      )}
    </div>
  );
};
