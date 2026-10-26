// 桌面桥接回调是宿主与 helper 的私有通道，不能依赖随机端口作为认证。
const { createServer } = require('node:http');
const { timingSafeEqual } = require('node:crypto');

function createBridgeCallbackServer({ token, onResponse, maxBodyBytes = 1024 * 1024 }) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('桌宠桥接认证令牌缺失或无效');
  const expected = Buffer.from('Bearer ' + token);
  const server = createServer((req, res) => {
    const respond = (status, message) => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      if (!res.writableEnded) res.end(message);
    };
    const port = server.address()?.port;
    if (!['127.0.0.1:' + port, 'localhost:' + port].includes(req.headers.host)) {
      respond(403, 'dsh-pet: invalid host'); req.resume(); return;
    }
    const supplied = Buffer.from(req.headers.authorization || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      respond(403, 'dsh-pet: unauthorized'); req.resume(); return;
    }
    if (req.method !== 'POST' || req.url !== '/respond') {
      respond(404, 'dsh-pet: not found'); req.resume(); return;
    }
    if (Number(req.headers['content-length']) > maxBodyBytes) {
      respond(413, 'dsh-pet: payload too large'); req.resume(); return;
    }
    const chunks = [];
    let length = 0;
    let rejected = false;
    const timer = setTimeout(() => { respond(408, 'dsh-pet: request timeout'); req.destroy(); }, 5000);
    timer.unref();
    req.once('close', () => clearTimeout(timer));
    req.on('data', chunk => {
      length += chunk.length;
      if (length > maxBodyBytes) {
        rejected = true;
        chunks.length = 0;
        respond(413, 'dsh-pet: payload too large');
      } else if (!rejected) chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      if (rejected) return;
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!payload || !Number.isSafeInteger(payload.id) || payload.id < 1 || !Number.isInteger(payload.status) || payload.status < 200 || payload.status > 599 ||
          ['body', 'file', 'contentType'].some(key => payload[key] !== undefined && typeof payload[key] !== 'string')) throw new Error('响应结构无效');
        onResponse(payload);
        respond(200, 'ok');
      } catch { respond(400, 'dsh-pet: bad payload'); }
    });
    req.on('error', () => { clearTimeout(timer); respond(400, 'dsh-pet: bad payload'); });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 10000;
  return server;
}

module.exports = { createBridgeCallbackServer };
