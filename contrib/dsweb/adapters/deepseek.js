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

  /// 定位发送键并返回中心坐标 "x,y"（daemon 用 CDP 真实鼠标事件点击——
  /// ds-button 组件监听 pointer/mouse 事件序列，JS .click() 只派发 click 不被识别）。
  /// 几何定位：输入框同带右侧；类名精确 ds-button--primary 优先
  /// （iconLabelPrimary 等"含 primary 字样"的类是别的键）
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
    const r = cands[0].r;
    return Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2);
  })()`,

  /// Enter 键兜底（send 点击失败时；仅单行文本可靠）
  enterFallback: true,

  /// 读消息列表：[{u:是否user, t:文本}] JSON。气泡级选择器——天然排除
  /// 虚拟列表镜像/输入区残留/侧栏，稳态与回复提取都在消息级做（不碰 innerText）
  readMsgs: `JSON.stringify([...document.querySelectorAll('.ds-message')].map(m => ({
    u: m.classList.contains('d29f3d7d'),
    t: (m.innerText || '').trim()
  })))`,

  /// 消息文本尾部的固定 UI 文案剥离表（改文案时更新此处）
  uiTail: ['内容由 AI 生成，请仔细甄别', '深度思考', '智能搜索', '重新生成', '分享', '停止生成'],
};
