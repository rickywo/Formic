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
      {stepNumber !== undefined && (
        <div
          style={{
            position: "absolute",
            top: 40,
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
            top: 44,
            right: 48,
            color: "rgba(255,255,255,0.8)",
            fontSize: 20,
            fontWeight: 600,
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
            bottom: 48,
            left: 0,
            right: 0,
            textAlign: "center",
            color: "rgba(255,255,255,0.6)",
            fontSize: 22,
            fontWeight: 400,
            letterSpacing: 0.5,
          }}
        >
          {caption}
        </div>
      )}
    </div>
  );
};
