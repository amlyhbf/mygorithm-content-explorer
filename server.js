// 맘고리즘 콘텐츠 탐색기 - 로컬 + Render 클라우드용
// Node.js 20 이상, 외부 패키지 설치 불필요
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const PORT = Number(process.env.PORT) || 8765;
const HOST = process.env.HOST || '0.0.0.0';
const html = fs.readFileSync(path.join(__dirname, 'index.html'));
const allowed = new Map([
  ['ko.wikipedia.org', '/w/api.php'],
  ['commons.wikimedia.org', '/w/api.php'],
  ['www.googleapis.com', '/youtube/v3/search'],
]);
const common = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, {...common, 'Content-Type': contentType});
  res.end(body);
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'HEAD' && (req.url === '/' || req.url === '/health')) {
      const type = req.url === '/' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8';
      res.writeHead(200, {...common, 'Content-Type': type});
      return res.end();
    }
    if (req.method !== 'GET') return send(res, 405, JSON.stringify({error:'GET만 지원합니다.'}));
    if ((req.url||'').length > 6500) return send(res, 414, JSON.stringify({error:'요청 주소가 너무 깁니다.'}));
    const u = new URL(req.url, `http://localhost:${PORT}`);
    if (u.pathname === '/') return send(res, 200, html, 'text/html; charset=utf-8');
    if (u.pathname === '/health') return send(res, 200, JSON.stringify({ok:true, app:'mygorithm-content-explorer'}));
    if (u.pathname !== '/api/proxy') return send(res, 404, JSON.stringify({error:'찾을 수 없습니다.'}));
    const raw = u.searchParams.get('url');
    if (!raw) return send(res, 400, JSON.stringify({error:'검색 주소가 없습니다.'}));
    let target;
    try { target = new URL(raw); } catch {return send(res,400,JSON.stringify({error:'검색 주소가 올바르지 않습니다.'}));}
    if (target.protocol !== 'https:' || target.port || allowed.get(target.hostname) !== target.pathname || target.username || target.password) {
      return send(res, 403, JSON.stringify({error:'허용되지 않은 검색 주소입니다.'}));
    }
    if (target.hostname === 'www.googleapis.com') {
      // 공유 서비스에서 다른 이용자의 API 키를 대신 처리하지 않도록 차단
      return send(res, 403, JSON.stringify({error:'공개 배포판에서 유튜브 API 직접 호출은 비활성화되었습니다.'}));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(target, {
        headers: {
          'User-Agent': 'MygorithmResearcher/0.4 (educational content exploration)',
          'Accept': 'application/json',
        },
        signal: controller.signal,
        redirect: 'error',
      });
      const type = response.headers.get('content-type') || '';
      if (!type.includes('json') && response.ok) {
        return send(res, 502, JSON.stringify({error:'검색 서비스가 JSON이 아닌 응답을 반환했습니다.'}));
      }
      const body = await response.text();
      if (body.length > 5_000_000) return send(res,502,JSON.stringify({error:'검색 결과 크기 초과'}));
      return send(res, response.status, body);
    } finally { clearTimeout(timeout); }
  } catch (e) {
    return send(res, 502, JSON.stringify({error:'외부 검색 연결 실패: '+ (e?.name === 'AbortError' ? '시간 초과' : e.message)}));
  }
});
server.listen(PORT, HOST, () => console.log(`맘고리즘 콘텐츠 탐색기: http://${HOST}:${PORT}`));
