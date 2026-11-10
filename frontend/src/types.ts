// claude stream-json 事件 → UI 块聚合模型
// sub = 子代理事件（parent_tool_use_id 非空）：缩进弱化渲染
// bid：reducer 创建时自增的稳定 id——render key 用它（位置键在历史窗口移动时整列 remount，
// 浏览器滚动锚定失效 → 上翻加载视图乱跳）
export type UIBlock = { bid: number } & (
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
  // AskUserQuestion 交互表单（TUI 同款单选/多选/其他输入）：questions 为 CLI 下发的
  // 结构化题面 [{question,header,options:[{label,description}],multiSelect}]；
  // done 落定后整卡保留（选项不塌缩）：summary=确认文案，answers=各题答案
  // （问题文本 → 标签|[标签...]|自定义文本；重连/回放由 tool_result 文本尽力还原）
  | { k: "form"; rid: string; tuid: string; questions: any[]; done?: { summary: string; answers?: Record<string, string | string[]> } }
  | { k: "note"; text: string }
);

export interface TabInfo {
  id: string;
  cwd: string;
}
