import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import type { ApiClient } from "./api/client.js";
import { Banners } from "./components/Banners.js";
import { TopBar } from "./components/TopBar.js";
import { ChatScreen } from "./screens/ChatScreen.js";
import { OverviewScreen } from "./screens/OverviewScreen.js";
import { ReviewScreen } from "./screens/ReviewScreen.js";
import { Screen } from "./screens/Screen.js";
import { SessionsScreen } from "./screens/SessionsScreen.js";
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
            <Route path="overview" element={<OverviewScreen />} />
            <Route path="tasks" element={<Screen title="Tasks" />} />
            <Route path="sessions" element={<SessionsScreen />} />
            <Route path="review" element={<ReviewScreen />} />
            <Route path="settings" element={<Screen title="Settings" />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </BrowserRouter>
    </LiveProvider>
  );
}
