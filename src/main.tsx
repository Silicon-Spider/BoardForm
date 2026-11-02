import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import "./styles/global.css";
import { ensureSeeded } from "@/storage";
import { initTrainingService } from "@/training";
import { initArenaService } from "@/arena";
import { toast } from "./app/toast";
import { applyTheme, watchSystemTheme } from "./app/preferences";

// Apply the saved colour theme before the first paint.
applyTheme();
watchSystemTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

async function boot() {
  // Seeding starts first, so whenSeeded() — which the services wait for — covers the starter
  // engines. The services do not wait for the starter network's download (ensureSeeded does).
  const seeding = ensureSeeded();
  try {
    initArenaService();
    initTrainingService();
  } catch (e) {
    console.error("Service init failed", e);
  }
  try {
    await seeding;
  } catch (e) {
    console.error("Seeding failed", e);
    toast("Could not create the starter engines", { kind: "error", detail: String(e) });
  }
}
void boot();
