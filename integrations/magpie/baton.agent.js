// A dedicated file gives Magpie sole ownership of these keys. Baton never writes it.
// Magpie evaluates agents in its own JavaScript runtime (without Node globals).
const directory = "~/.baton/v2";
export const agent = {
  id: "baton",
  name: "Baton",
  dir: directory,
  config: `${directory}/magpie.json`,
  format: "json",
  model: "model",
  ua: ["Baton"],
  notice: "默认模型用于新对话；已有对话保持原选择。请在 Baton 设置中勾选聊天框可切换的模型，运行中的任务结束后同步连接。",
};
export function connect({ gateway }) {
  return { enabled: true, gateway: { url: gateway.v1, key: gateway.key } };
}
