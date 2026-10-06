import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import type { ApiClient } from "./api/client.js";
import { Banners } from "./components/Banners.js";
import { TopBar } from "./components/TopBar.js";
import { ChatScreen } from "./screens/ChatScreen.js";
import { Screen } from "./screens/Screen.js";
import { LiveProvider } from "./store/hooks.js";
import type { Store } from "./store/store.js";

export function App({ store, api }: { store: Store; api: ApiClient }) {
  return (
    <LiveProvider store={store} api={api}>
      <BrowserRouter>
        <TopBar />
        <Banners />
        <main className="content">
          <Routes>
            <Route index element={<ChatScreen />} />
            <Route path="overview" element={<Screen title="Overview" />} />
            <Route path="tasks" element={<Screen title="Tasks" />} />
            <Route path="sessions" element={<Screen title="Sessions" />} />
            <Route path="review" element={<Screen title="Review" />} />
            <Route path="settings" element={<Screen title="Settings" />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </BrowserRouter>
    </LiveProvider>
  );
}
