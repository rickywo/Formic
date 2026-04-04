import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate, Img, staticFile } from "remotion";
import { SceneContainer } from "../components/SceneContainer";
import { ChatBubble } from "../components/ChatBubble";

const DURATION = 270; // 9 seconds

export const ChatScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const panelEntry = spring({
    frame,
    fps,
    config: { damping: 12, stiffness: 80 },
  });

  return (
    <SceneContainer
      durationInFrames={DURATION}
      stepNumber={4}
      heading="💬 Brainstorm with AI"
      caption="Just describe what you want in plain English."
    >
      <div
        style={{
          width: 850,
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
          border: "1px solid rgba(255,255,255,0.08)",
          opacity: panelEntry,
          transform: `scale(${interpolate(panelEntry, [0, 1], [0.9, 1])})`,
        }}
      >
        {/* Chat header */}
        <div
          style={{
            height: 52,
            background: "#1e1e2e",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            alignItems: "center",
            padding: "0 20px",
            gap: 10,
          }}
        >
          <Img src={staticFile("formic.png")} style={{ width: 22, height: 22 }} />
          <span style={{ color: "#fff", fontWeight: 600, fontSize: 16 }}>
            Formic AI Assistant
          </span>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#27c93f",
              marginLeft: 4,
            }}
          />
        </div>

        {/* Chat messages */}
        <div
          style={{
            background: "#0d0d1a",
            padding: "24px 20px",
            minHeight: 320,
          }}
        >
          <ChatBubble
            sender="user"
            name="You"
            message="I want to add a dark mode toggle to my React app. It should persist the user's preference and support system theme detection."
            startFrame={20}
          />
          <ChatBubble
            sender="ai"
            name="Formic AI"
            message="Great idea! I can see your project uses Tailwind CSS and React Context. I'd recommend creating a ThemeProvider with localStorage persistence and a prefers-color-scheme media query listener. Want me to create a Goal task to break this down?"
            startFrame={70}
          />
          <ChatBubble
            sender="user"
            name="You"
            message="Yes! Create a goal task for it."
            startFrame={140}
          />
        </div>
      </div>
    </SceneContainer>
  );
};

export const CHAT_DURATION = DURATION;
