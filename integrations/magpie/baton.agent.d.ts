export const agent: {
  id: string; name: string; dir: string; config: string; format: string;
  model: string; ua: string[]; notice: string;
};
export function connect(input: { gateway: { v1: string; key: string } }): {
  enabled: boolean; gateway: { url: string; key: string };
};
