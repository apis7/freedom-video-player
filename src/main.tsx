import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { UiErrorBoundary } from "./components/UiErrorBoundary";
import { installUiErrorReporter } from "./utils/uiErrorReporter";
import "./styles/index.css";

// Install BEFORE React mounts so any error during the first render is
// captured. window.error / unhandledrejection / console.error all
// forward to the [fvp:ui] terminal log.
installUiErrorReporter();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UiErrorBoundary>
      <App />
    </UiErrorBoundary>
  </React.StrictMode>,
);
