import { useEffect, useState } from "react";
import { LaptopMinimal } from "lucide-react";
import { toast } from "sonner";
import type { Access, ModelPick, Project, Thread } from "@baton/core/types";
import { post } from "@/lib/api";
import { useBaton } from "@/lib/store";
import { Composer, ProjectMenu, rememberedModel, rememberModel } from "./composer";

export function Draft({ text, onText, project, onProject, onOpen, onStarted, onSettings }: { text: string; onText: (text: string) => void; project?: Project; onProject: (project?: Project) => void; onOpen: () => void; onStarted: (thread: Thread) => void; onSettings: () => void }) {
  const { state, refresh } = useBaton();
  const [pick, setPick] = useState<ModelPick | undefined>(rememberedModel), [access, setAccess] = useState<Access>("ask"), [busy, setBusy] = useState(false);
  useEffect(() => { setAccess("ask"); }, [project?.id]);
  const models = state?.gateway.models.filter(m => m.verified) ?? [];
  const selected = models.find(m => m.id === pick?.id) ?? models[0];
  const model: ModelPick | undefined = selected ? { id: selected.id, thinking: (pick?.thinking && selected.thinking.includes(pick.thinking)) ? pick?.thinking : selected.thinking[0], ...(selected.id === pick?.id && selected.fastMode && pick.serviceTier === "priority" ? { serviceTier: "priority" } : {}) } : undefined;
  const send = async () => {
    if (busy || !text.trim() || !model) return;
    setBusy(true);
    try {
      const thread = await post<Thread>("/api/threads/start", { text, model, access, projectId: project?.id });
      rememberModel(model); await refresh(); onStarted(thread);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return <div className="draft-page"><div className="draft-content">
    <h1>我们要做什么？</h1>
    <Composer text={text} onText={onText} onSend={() => void send()} busy={busy} model={model} onModel={setPick} project={project} access={access} onAccess={setAccess} onSettings={onSettings} tray={<><ProjectMenu project={project} onSelect={onProject} onOpen={onOpen}/><span className="tray-location"><LaptopMinimal size={17}/>本机</span></>}/>
    {!models.length && <p className="draft-connection">先连接模型，即可开始。<button className="text-button" onClick={onSettings}>设置 Magpie</button></p>}
  </div></div>;
}
