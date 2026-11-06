// claude stream-json 事件 → UI 块聚合模型
export type UIBlock =
  | { k: "user"; text: string }
  | { k: "text"; text: string; live?: boolean }
  | { k: "think"; text: string; live?: boolean }
  | {
      k: "tool";
      id: string;
      name: string;
      inputJson: string;
      live?: boolean;
      result?: string;
      isError?: boolean;
    }
  | { k: "stats"; durMs: number; cost: number; tokens: number }
  | { k: "note"; text: string };

export interface TabInfo {
  id: string;
  cwd: string;
}
