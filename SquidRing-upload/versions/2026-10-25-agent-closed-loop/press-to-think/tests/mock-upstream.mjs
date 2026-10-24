import http from 'node:http';

const fullAnswer = '结论是应该先验证核心交互，而不是继续增加功能。第一，长按输入必须稳定，这是产品存在的基础。第二，回答完成后由用户双击播放，可以避免打断音乐。第三，完整内容保留在手机里，方便之后查看。除此之外，账号系统、社交功能和复杂的模型市场现在都不是重点。下一步应该先测试二十次连续录音，记录成功率、响应时间和用户是否愿意重复使用。';

http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body || '{}');
  const isSummary = request.messages?.[0]?.content?.includes('语音内容编辑');
  // 故意让摘要模型复读全文，用来验证服务端的“过度相似”兜底。
  const content = isSummary ? JSON.stringify({ spokenAnswer: fullAnswer }) : fullAnswer;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
}).listen(3999, '127.0.0.1', () => console.log('mock upstream ready'));
