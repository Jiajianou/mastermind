import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import type { ApiClient } from "./api/client.js";
import { Banners } from "./components/Banners.js";
import { TopBar } from "./components/TopBar.js";
import { ChatScreen } from "./screens/ChatScreen.js";
import { DecideScreen } from "./screens/DecideScreen.js";
import { OverviewScreen } from "./screens/OverviewScreen.js";
import { RequestChangesScreen } from "./screens/RequestChangesScreen.js";
import { ReviewScreen } from "./screens/ReviewScreen.js";
import { SessionsScreen } from "./screens/SessionsScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";
import { TasksScreen } from "./screens/TasksScreen.js";
import { DesktopNotifications } from "./notifications/DesktopNotifications.js";
import { LiveProvider } from "./store/hooks.js";
import type { Store } from "./store/store.js";

export function App({ store, api }: { store: Store; api: ApiClient }) {
  return (
    <LiveProvider store={store} api={api}>
      <BrowserRouter>
        <TopBar />
        <Banners />
        <DesktopNotifications />
        <main className="content">
          <Routes>
            <Route index element={<ChatScreen />} />
            <Route path="overview" element={<OverviewScreen />} />
            <Route path="tasks" element={<TasksScreen />} />
            <Route path="sessions" element={<SessionsScreen />} />
            <Route path="review" element={<ReviewScreen />} />
            <Route path="review/decide/:taskId" element={<DecideScreen />} />
            <Route
              path="review/decide/:taskId/request-changes"
              element={<RequestChangesScreen />}
            />
            <Route path="settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </BrowserRouter>
    </LiveProvider>
  );
}
