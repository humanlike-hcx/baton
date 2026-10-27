import { useCallback } from "react";
import { post } from "./api";
import { useBaton } from "./store";
import type { AppStateResponse, Project } from "./types";

export function projectOfThread(state: AppStateResponse | undefined, threadId: string): Project | undefined {
  return state?.projects.find((p) => p.threads.some((t) => t.id === threadId));
}

/** The system folder dialog. Undefined when the user cancels. */
export async function chooseProjectDirectory(): Promise<string | undefined> {
  const picked = await post<{ path?: string; cancelled?: boolean }>("/api/workspace/pick");
  return picked.path;
}

/** Makes `root` the current project; chats in other projects keep running. */
export function useSwitchProject() {
  const { state, refresh } = useBaton();
  return useCallback(
    async (root: string) => {
      if (state?.workspace.root === root) return;
      await post("/api/workspace/open", { path: root });
      await refresh();
    },
    [state?.workspace.root, refresh],
  );
}
