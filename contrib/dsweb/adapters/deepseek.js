// DeepSeek 网页适配器（2026-11-08 · 消息级选择器版）
// 页面适配层 = 全部触碰 DeepSeek DOM 的代码，从 daemon 核心剥离——改版时只改这个文件
// （daemon 按文件 mtime 热重载，浏览器/登录态/队列不动）。
//
// 2026-11 实测要点（相对 gb10 旧版 daemon）：
//   - 消息气泡选择器 .ds-message / .d29f3d7d（user 标记）依然有效——
//     曾经误判"选择器消失"，真因是新版 Enter 对多行文本=换行导致消息从未发出
//   - Enter 只对单行可靠 → 发送改点 div.ds-button--primary（几何定位：输入框右下）
//   - 虚拟列表（.ds-virtual-list）里有消息镜像（无 ds-message 类）——
//     消息级选择器天然排除之；innerText 差分方案会被 textarea 值残留坑死，弃用
module.exports = {
  name: 'deepseek',
  version: '2026-11-08b',
  urlMatch: /deepseek/i,
  homeUrl: 'https://chat.deepseek.com/',

  /// 对话页就绪 = 输入框出现
  isReady: `(function(){ return !!document.querySelector('textarea'); })()`,

  /// 聚焦输入框（填充由 daemon 用 CDP Input.insertText 做——输入法级真实输入，
  /// React 状态必然同步；native setter + input 事件会绕过 ValueTracker，
  /// textarea.value 有值但组件 state 仍空，发送键点击无效，2026-11 实测）
  fill: `(() => { const ta = document.querySelector('textarea'); if (!ta) return false; ta.focus(); return true; })()`,

  /// 点发送键：el.click()（fill 已用 insertText 同步 React state，点击有效——
  /// 2026-11 实测；几何定位输入框同带右侧，类名精确 ds-button--primary 优先，
  /// iconLabelPrimary 等"含 primary 字样"的类是别的键）
  send: `(function(){
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    const tr = ta.getBoundingClientRect();
    const cands = [...document.querySelectorAll('[class*="ds-button"]')]
      .map(el => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0)
      .filter(({ r }) => r.top < tr.bottom + 40 && r.bottom > tr.top - 40 && r.left >= tr.left)
      .sort((a, b) => (b.el.classList.contains('ds-button--primary') ? 1 : 0) - (a.el.classList.contains('ds-button--primary') ? 1 : 0));
    if (!cands.length) return false;
    cands[0].el.click();
    return true;
  })()`,

  /// Enter 键兜底（send 点击失败时；仅单行文本可靠）
  enterFallback: true,

  /// 读对话文本：右列（主聊天列）几何定位——与输入框同列（left ≥ 输入框左-60）、
  /// 在输入框上方（bottom ≤ 输入框顶+30）的容器里取文本最长者（不设子元素数上限——
  /// 消息积累后列表容器子节点多，上限会把它整个过滤掉，2026-11 实测）。
  /// 新会话与历史会话是两套渲染组件（后者才有 .ds-message 气泡）——气泡选择器
  /// 覆盖不全；几何法两态通吃，且天然排除侧栏（左侧）/输入区（下方）。
  /// 锚点差分与 UI 尾剥离由 daemon 做。
  readMain: `(function(){
    // 虚拟列表只渲染视口内消息——先滚到底让最新消息（锚点/回复）进 DOM
    for (const el of document.querySelectorAll('[class*="virtual-list"], [class*="scroll-area"]')) {
      try { el.scrollTop = el.scrollHeight; } catch (e) {}
    }
    const ta = document.querySelector('textarea');
    if (!ta) return '';
    const tr = ta.getBoundingClientRect();
    let best = '';
    for (const el of document.querySelectorAll('div')) {
      const r = el.getBoundingClientRect();
      if (r.width > 300 && r.left >= tr.left - 60 && r.bottom <= tr.top + 30) {
        const t = (el.innerText || '').trim();
        if (t.length > best.length) best = t;
      }
    }
    return best;
  })()`,

  /// 消息文本尾部的固定 UI 文案剥离表（改文案时更新此处）
  uiTail: ['内容由 AI 生成，请仔细甄别', '深度思考', '智能搜索', '重新生成', '分享', '停止生成'],
};
