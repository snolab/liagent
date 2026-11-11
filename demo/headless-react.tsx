// The headless React example (examples/react/HeadlessChat.tsx) on the dev
// hub: bundled per request by scripts/dev.ts as <BASE>/headless-react.js,
// opened as <BASE>/headless-react.html.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HeadlessChat } from "../examples/react/HeadlessChat";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HeadlessChat url="./api/chat" />
  </StrictMode>,
);
