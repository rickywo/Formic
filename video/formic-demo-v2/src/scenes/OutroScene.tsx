import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { SceneContainer } from "../components/SceneContainer";

const DURATION = 150; // 5 seconds

export const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoEntry = spring({
    frame,
    fps,
    config: { damping: 10, stiffness: 60 },
  });

  const taglineEntry = spring({
    frame: Math.max(0, frame - 15),
    fps,
    config: { damping: 12, stiffness: 80 },
  });

  const installEntry = spring({
    frame: Math.max(0, frame - 30),
    fps,
    config: { damping: 12, stiffness: 80 },
  });

  const footerEntry = spring({
    frame: Math.max(0, frame - 45),
    fps,
    config: { damping: 12, stiffness: 80 },
  });

  const glowPulse = Math.sin(frame * 0.08) * 0.3 + 0.7;

  return (
    <SceneContainer
      durationInFrames={DURATION}
      bgGradient="radial-gradient(ellipse at 50% 40%, rgba(99,102,241,0.15) 0%, #0d0d1a 50%, #0a0a0f 100%)"
    >
      {/* Ambient glow */}
      <div
        style={{
          position: "absolute",
          width: 400,
          height: 400,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(139,92,246,0.2) 0%, transparent 70%)",
          top: "25%",
          left: "50%",
          transform: "translateX(-50%)",
          opacity: glowPulse,
          filter: "blur(50px)",
        }}
      />

      {/* Logo + title */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 24,
          opacity: logoEntry,
          transform: `scale(${logoEntry})`,
        }}
      >
        <span
          style={{
            fontSize: 48,
            filter: `drop-shadow(0 0 ${15 * glowPulse}px rgba(139,92,246,0.6))`,
          }}
        >
          🐜
        </span>
        <span
          style={{
            fontSize: 48,
            fontWeight: 800,
            color: "#fff",
            letterSpacing: 10,
            textShadow: "0 0 30px rgba(99,102,241,0.4)",
          }}
        >
          FORMIC
        </span>
      </div>

      {/* Tagline */}
      <div
        style={{
          fontSize: 28,
          fontWeight: 600,
          color: "#fff",
          marginBottom: 36,
          opacity: taglineEntry,
          transform: `translateY(${interpolate(taglineEntry, [0, 1], [15, 0])}px)`,
        }}
      >
        Stop coding. Start shipping.
      </div>

      {/* Install command */}
      <div
        style={{
          padding: "16px 32px",
          borderRadius: 12,
          background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,255,255,0.1)",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 18,
          color: "#27c93f",
          marginBottom: 32,
          opacity: installEntry,
          transform: `translateY(${interpolate(installEntry, [0, 1], [15, 0])}px)`,
        }}
      >
        npm install -g @rickywo/formic
      </div>

      {/* Footer */}
      <div
        style={{
          fontSize: 15,
          color: "rgba(255,255,255,0.4)",
          opacity: footerEntry,
          transform: `translateY(${interpolate(footerEntry, [0, 1], [10, 0])}px)`,
        }}
      >
        github.com/nickyWo/formic · Open Source · MIT License
      </div>
    </SceneContainer>
  );
};

export const OUTRO_DURATION = DURATION;
