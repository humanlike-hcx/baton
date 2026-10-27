import { useEffect, useState } from "react";

/** `threads` without an id is a new chat: what Baton opens into. */
export type Route =
  | { page: "threads"; threadId?: string }
  | { page: "models" }
  | { page: "context"; tab?: string }
  | { page: "stats" }
  | { page: "settings"; tab?: string };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  switch (parts[0]) {
    case "threads":
      return { page: "threads", threadId: parts[1] };
    case "models":
    case "agents":
      return { page: "models" };
    case "context":
      return { page: "context", tab: parts[1] };
    case "stats":
      return { page: "stats" };
    case "settings":
      return parts[1] === "accounts" ? { page: "models" } : { page: "settings", tab: parts[1] };
    default:
      return { page: "threads" };
  }
}

export function href(route: Route): string {
  switch (route.page) {
    case "threads":
      return route.threadId ? `#/threads/${route.threadId}` : "#/";
    case "context":
      return route.tab ? `#/context/${route.tab}` : "#/context";
    case "settings":
      return route.tab ? `#/settings/${route.tab}` : "#/settings";
    default:
      return `#/${route.page}`;
  }
}

export function navigate(route: Route): void {
  window.location.hash = href(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
