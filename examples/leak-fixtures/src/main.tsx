import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { init } from "react-memory-detective";
import { App } from "./App";
import "./styles.css";

if (import.meta.env.DEV) {
  init({ mode: "console", cleanupGracePeriodMs: 800 });
  void import("react-memory-detective/overlay").then(({ mountOverlay }) => mountOverlay());
  void import("react-memory-detective").then((rmd) => {
    (window as unknown as { rmd: typeof rmd }).rmd = rmd;
  });
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
