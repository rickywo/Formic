import React from "react";
import { Composition } from "remotion";
import { FormicDemo } from "./FormicDemo";

export const Root: React.FC = () => {
  return (
    <Composition
      id="FormicDemo"
      component={FormicDemo}
      durationInFrames={2160}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
