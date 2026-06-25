import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import Capture from "./Capture";
import "./styles.css";

const isCapture = "__TAURI_INTERNALS__" in window && getCurrentWindow().label === "capture";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isCapture ? <Capture /> : <App />}</React.StrictMode>,
);
