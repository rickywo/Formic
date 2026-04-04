import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { TitleScene, TITLE_DURATION } from "./scenes/TitleScene";
import { InstallScene, INSTALL_DURATION } from "./scenes/InstallScene";
import { StartScene, START_DURATION } from "./scenes/StartScene";
import { WorkspaceScene, WORKSPACE_DURATION } from "./scenes/WorkspaceScene";
import { ChatScene, CHAT_DURATION } from "./scenes/ChatScene";
import { GoalTaskScene, GOAL_DURATION } from "./scenes/GoalTaskScene";
import { ArchitectScene, ARCHITECT_DURATION } from "./scenes/ArchitectScene";
import { ProcessingScene, PROCESSING_DURATION } from "./scenes/ProcessingScene";
import { ReviewScene, REVIEW_DURATION } from "./scenes/ReviewScene";
import { OutroScene, OUTRO_DURATION } from "./scenes/OutroScene";

// Scene timing: 5+7+7+6+9+8+9+8+8+5 = 72 seconds = 2160 frames at 30fps
const scenes = [
  { Component: TitleScene, duration: TITLE_DURATION },        // 0-150    (5s)
  { Component: InstallScene, duration: INSTALL_DURATION },    // 150-360  (7s)
  { Component: StartScene, duration: START_DURATION },        // 360-570  (7s)
  { Component: WorkspaceScene, duration: WORKSPACE_DURATION },// 570-750  (6s)
  { Component: ChatScene, duration: CHAT_DURATION },          // 750-1020 (9s)
  { Component: GoalTaskScene, duration: GOAL_DURATION },      // 1020-1260(8s)
  { Component: ArchitectScene, duration: ARCHITECT_DURATION },// 1260-1530(9s)
  { Component: ProcessingScene, duration: PROCESSING_DURATION },// 1530-1770(8s)
  { Component: ReviewScene, duration: REVIEW_DURATION },      // 1770-2010(8s)
  { Component: OutroScene, duration: OUTRO_DURATION },        // 2010-2160(5s)
];

export const FormicDemo: React.FC = () => {
  let currentFrame = 0;

  return (
    <AbsoluteFill style={{ background: "#0a0a0f" }}>
      {scenes.map(({ Component, duration }, i) => {
        const from = currentFrame;
        currentFrame += duration;
        return (
          <Sequence key={i} from={from} durationInFrames={duration}>
            <Component />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
