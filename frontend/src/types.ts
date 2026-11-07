// claude stream-json 事件 → UI 块聚合模型
// sub = 子代理事件（parent_tool_use_id 非空）：缩进弱化渲染
export type UIBlock =
  | { k: "user"; text: string; imgs?: number }
  | { k: "text"; text: string; live?: boolean; sub?: boolean }
  | { k: "think"; text: string; live?: boolean; sub?: boolean }
  | {
      k: "tool";
      id: string;
      name: string;
      inputJson: string;
      live?: boolean;
      result?: string;
      isError?: boolean;
      sub?: boolean;
    }
  // 权限询问卡片：rid=request_id（回包用）、tuid=tool_use_id（tool_result 关联解决态）
  | { k: "ask"; rid: string; tuid: string; tool: string; inputJson: string; done?: "allow" | "deny" }
  | { k: "stats"; durMs: number; cost: number; tokens: number }
  | { k: "note"; text: string };

export interface TabInfo {
  id: string;
  cwd: string;
}
