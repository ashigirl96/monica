import { AppLayout } from "@/app/layout";
import { RunspaceWindow } from "@/app/runspace-window";
import { isRunspaceWindow } from "@/lib/runspace-window";

function App() {
  return isRunspaceWindow() ? <RunspaceWindow /> : <AppLayout />;
}

export default App;
