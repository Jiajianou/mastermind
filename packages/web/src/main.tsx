import { streamPath, webStreamProtocols } from "@mastermind/core/contracts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient } from "./api/client.js";
import { takeAccessToken } from "./api/token.js";
import { App } from "./App.js";
import { connectLive } from "./live/connection.js";
import { createStore } from "./store/store.js";
import "./theme/theme.js";

const token = takeAccessToken(window);
const store = createStore();
const api = createApiClient(token);

if (token === null) {
  store.dispatch({ type: "connection.changed", connection: "unauthorized" });
} else {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const streamUrl = `${scheme}://${window.location.host}${streamPath}`;
  connectLive({
    store,
    api,
    openSocket: () => new WebSocket(streamUrl, webStreamProtocols(token)),
  });
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root element");
}

createRoot(container).render(
  <StrictMode>
    <App store={store} api={api} />
  </StrictMode>,
);
