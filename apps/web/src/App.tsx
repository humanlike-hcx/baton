import { AgentsPage } from "@/components/agents-page";
import { AppShell } from "@/components/app-shell";
import { ContextPage } from "@/components/context-page";
import { NewThread } from "@/components/new-thread";
import { SettingsPage } from "@/components/settings-page";
import { StatsPage } from "@/components/stats-page";
import { ThreadView } from "@/components/thread-view";
import { ThreadsHome } from "@/components/threads-home";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useRoute, type Route } from "@/lib/router";
import { WorkbenchProvider } from "@/lib/store";

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case "threads":
      return route.threadId ? <ThreadView key={route.threadId} threadId={route.threadId} /> : <ThreadsHome />;
    case "new":
      return <NewThread />;
    case "agents":
      return <AgentsPage />;
    case "context":
      return <ContextPage tab={route.tab} />;
    case "stats":
      return <StatsPage />;
    case "settings":
      return <SettingsPage tab={route.tab} />;
  }
}

export default function App() {
  const route = useRoute();
  return (
    <WorkbenchProvider>
      <TooltipProvider>
        <AppShell route={route}>
          <Page route={route} />
        </AppShell>
        <Toaster position="top-center" richColors />
      </TooltipProvider>
    </WorkbenchProvider>
  );
}
