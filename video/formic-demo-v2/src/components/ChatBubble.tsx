import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";

interface ChatBubbleProps {
  message: string;
  sender: "user" | "ai";
  startFrame?: number;
  name?: string;
}

export const ChatBubble: React.FC<ChatBubbleProps> = ({
  message,
  sender,
  startFrame = 0,
  name,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = Math.max(0, frame - startFrame);

  const slideIn = spring({
    frame: localFrame,
    fps,
    config: { damping: 12, stiffness: 100 },
  });

  const translateY = interpolate(slideIn, [0, 1], [30, 0]);
  const opacity = interpolate(slideIn, [0, 1], [0, 1]);

  const isUser = sender === "user";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        alignItems: "flex-start",
        gap: 12,
        opacity,
        transform: `translateY(${translateY}px)`,
        marginBottom: 16,
      }}
    >
      {!isUser && (
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 20,
            flexShrink: 0,
          }}
        >
          🐜
        </div>
      )}
      <div
        style={{
          maxWidth: 600,
          padding: "14px 20px",
          borderRadius: isUser ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
          background: isUser
            ? "linear-gradient(135deg, #6366f1, #8b5cf6)"
            : "rgba(255,255,255,0.08)",
          color: "#fff",
          fontSize: 17,
          lineHeight: 1.5,
          border: isUser ? "none" : "1px solid rgba(255,255,255,0.1)",
        }}
      >
        {name && (
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: isUser ? "rgba(255,255,255,0.7)" : "#8b5cf6",
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            {name}
          </div>
        )}
        {message}
      </div>
      {isUser && (
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #374151, #4b5563)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 18,
            flexShrink: 0,
          }}
        >
          👤
        </div>
      )}
    </div>
  );
};
