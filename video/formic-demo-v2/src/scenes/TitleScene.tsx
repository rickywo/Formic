import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { SceneContainer } from "../components/SceneContainer";

const DURATION = 150; // 5 seconds at 30fps

export const TitleScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoScale = spring({
    frame,
    fps,
    config: { damping: 10, stiffness: 60 },
  });

  const titleSlide = spring({
    frame: Math.max(0, frame - 15),
    fps,
    config: { damping: 12, stiffness: 80 },
  });

  const taglineSlide = spring({
    frame: Math.max(0, frame - 30),
    fps,
    config: { damping: 12, stiffness: 80 },
  });

  const subtitleSlide = spring({
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
      {/* Ambient glow orb */}
      <div
        style={{
          position: "absolute",
          width: 500,
          height: 500,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(139,92,246,0.2) 0%, transparent 70%)",
          top: "20%",
          left: "50%",
          transform: "translateX(-50%)",
          opacity: glowPulse,
          filter: "blur(60px)",
        }}
      />

      {/* Logo */}
      <div
        style={{
          fontSize: 80,
          transform: `scale(${logoScale})`,
          marginBottom: 20,
          filter: `drop-shadow(0 0 ${20 * glowPulse}px rgba(139,92,246,0.6))`,
        }}
      >
        🐜
      </div>

      {/* Title */}
      <div
        style={{
          fontSize: 72,
          fontWeight: 800,
          color: "#fff",
          letterSpacing: 16,
          textShadow: "0 0 40px rgba(99,102,241,0.5), 0 0 80px rgba(139,92,246,0.3)",
          opacity: titleSlide,
          transform: `translateY(${interpolate(titleSlide, [0, 1], [20, 0])}px)`,
          marginBottom: 16,
        }}
      >
        FORMIC
      </div>

      {/* Tagline */}
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          color: "#8b5cf6",
          letterSpacing: 6,
          textTransform: "uppercase",
          opacity: taglineSlide,
          transform: `translateY(${interpolate(taglineSlide, [0, 1], [15, 0])}px)`,
          marginBottom: 24,
        }}
      >
        AI-POWERED TASK AUTOMATION
      </div>

      {/* Subtitle */}
      <div
        style={{
          fontSize: 20,
          color: "rgba(255,255,255,0.5)",
          fontWeight: 400,
          opacity: subtitleSlide,
          transform: `translateY(${interpolate(subtitleSlide, [0, 1], [15, 0])}px)`,
        }}
      >
        Describe what you want. AI builds it for you.
      </div>
    </SceneContainer>
  );
};

export const TITLE_DURATION = DURATION;
