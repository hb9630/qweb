// dsweb 桩服务：无需 DeepSeek 网页即可全流程验证 qtom。
// 行为：请求体不含 role:tool → 回文本流 + 一个 bash 工具调用（tool_calls 收尾）；
//       请求体含 role:tool → 回文本流 + stop 收尾。
// 每次请求体落盘 last-req.json（供断言再水化/messages 形态）。
// 用法：node frontend/test/dsweb-stub.mjs [port=8312]
import http from 'node:http';
import fs from 'node:fs';

const PORT = +(process.argv[2] || 8312);
const TOKEN = 't';
let slow = process.env.STUB_SLOW === '1'; // 慢流模式（中断测试）

const sse = (res, chunks, finish) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let i = 0;
  const tick = () => {
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', choices: [{ index: 0, delta: chunks[i++], finish_reason: null }] })}\n\n`);
      setTimeout(tick, slow ? 200 : 30);
    } else {
      res.write(`data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };
  tick();
};

http.createServer((req, res) => {
  let b = '';
  req.on('data', d => b += d);
  req.on('end', () => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401); return res.end('{"error":{"message":"bad token"}}');
    }
    const body = JSON.parse(b);
    fs.writeFileSync(new URL('./last-req.json', import.meta.url), JSON.stringify(body, null, 2));
    const hasToolResult = (body.messages || []).some(m => m.role === 'tool');
    console.log(`[stub] ${req.url} messages=${body.messages?.length} tools=${body.tools?.length || 0} toolResult=${hasToolResult}`);
    if (req.url === '/v1/chat/completions') {
      if (hasToolResult) {
        sse(res, [
          { role: 'assistant', content: '命令输出收到，' },
          { role: 'assistant', content: '任务完成喵。' },
        ], 'stop');
      } else {
        // 一个原子 tool_calls 块（daemon 桥的真实形态）
        sse(res, [
          { role: 'assistant', content: '我运行一下命令。' },
          { role: 'assistant', content: '' , tool_calls: [{ index: 0, id: 'call_dsweb_1', type: 'function', function: { name: 'bash', arguments: '{"command":"echo hi"}' } }] },
        ], 'tool_calls');
      }
    } else {
      res.writeHead(404); res.end('{}');
    }
  });
}).listen(PORT, '127.0.0.1', () => console.log(`dsweb stub on :${PORT} (token ${TOKEN})`));
