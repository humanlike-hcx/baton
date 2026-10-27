import { AppShell } from "@/components/app-shell";
import { ContextPage } from "@/components/context-page";
import { ModelsPage } from "@/components/models-page";
import { NewChat } from "@/components/new-chat";
import { SettingsPage } from "@/components/settings-page";
import { StatsPage } from "@/components/stats-page";
import { ThreadView } from "@/components/thread-view";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useRoute, type Route } from "@/lib/router";
import { BatonProvider } from "@/lib/store";

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case "threads":
      return route.threadId ? <ThreadView key={route.threadId} threadId={route.threadId} /> : <NewChat />;
    case "models":
      return <ModelsPage />;
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
    <BatonProvider>
      <TooltipProvider>
        <AppShell route={route}>
          <Page route={route} />
        </AppShell>
        <Toaster position="top-center" richColors />
      </TooltipProvider>
    </BatonProvider>
  );
}
