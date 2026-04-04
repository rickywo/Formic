import React from "react";
import { useCurrentFrame } from "remotion";

interface TypewriterProps {
  text: string;
  startFrame?: number;
  speed?: number;
  color?: string;
  prefix?: string;
}

export const Typewriter: React.FC<TypewriterProps> = ({
  text,
  startFrame = 0,
  speed = 2,
  color = "#27c93f",
  prefix = "$ ",
}) => {
  const frame = useCurrentFrame();
  const elapsed = Math.max(0, frame - startFrame);
  const charsToShow = Math.min(Math.floor(elapsed / speed), text.length);
  const displayText = text.substring(0, charsToShow);
  const showCursor = elapsed < text.length * speed + 20;

  return (
    <div style={{ display: "flex", whiteSpace: "pre" }}>
      <span style={{ color: "#8b5cf6" }}>{prefix}</span>
      <span style={{ color }}>{displayText}</span>
      {showCursor && (
        <span
          style={{
            color,
            opacity: Math.sin(frame * 0.3) > 0 ? 1 : 0,
          }}
        >
          ▋
        </span>
      )}
    </div>
  );
};
