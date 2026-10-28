// 맘고리즘 콘텐츠 탐색기 - Render + 로컬 서버
// 검색 요청 증가에 대응: 동시 요청 제한, 중복 요청 합치기, 캐시, 일시 장애 재시도
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 8765;
const HOST = process.env.HOST || '0.0.0.0';
const html = fs.readFileSync(path.join(__dirname, 'index.html'));
const allowed = new Map([
  ['ko.wikipedia.org','/w/api.php'],
  ['commons.wikimedia.org','/w/api.php']
]);
const common = {
  'Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'X-Frame-Options':'DENY'
};
const USER_AGENT = 'MygorithmContentExplorer/0.7 (https://github.com/amlyhbf/mygorithm-content-explorer; school research app)';
const MAX_ACTIVE = 2; // Wikimedia recommended <=3 concurrent requests
const MAX_PENDING = 24;
const CACHE_TTL = 12 * 60 * 1000;
const CACHE_LIMIT = 120;
const FETCH_TIMEOUT = 13000;
const cache = new Map();
const inFlight = new Map();
const pending = [];
let active = 0;
function send(res,status,body,contentType='application/json; charset=utf-8',extra={}) {
  res.writeHead(status,{...common,...extra,'Content-Type':contentType});
  res.end(body);
}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function schedule(work) {
  if(active>=MAX_ACTIVE && pending.length>=MAX_PENDING) {
    return Promise.resolve({status:503,body:JSON.stringify({error:'검색 대기 요청이 많습니다. 잠시 후 다시 검색해 주세요.'})});
  }
  return new Promise(resolve=>{
    pending.push(async()=>{
      active++;
      try{resolve(await work());}
      catch(e){resolve({status:502,body:JSON.stringify({error:'검색 중계 내부 오류: '+e.message})});}
      finally{active--;pump();}
    });
    pump();
  });
}
function pump(){
  while(active<MAX_ACTIVE && pending.length)pending.shift()();
}
function cacheGet(key){
  const saved=cache.get(key);
  if(!saved)return null;
  if(saved.until<Date.now()){cache.delete(key);return null;}
  cache.delete(key);cache.set(key,saved);
  return saved.result;
}
function cachePut(key,result){
  cache.set(key,{until:Date.now()+CACHE_TTL,result});
  while(cache.size>CACHE_LIMIT)cache.delete(cache.keys().next().value);
}
async function callUpstream(target) {
  let last={status:502,body:JSON.stringify({error:'검색 API 연결 실패'})};
  for(let attempt=0;attempt<2;attempt++){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),FETCH_TIMEOUT);
    try{
      const response=await fetch(target,{
        headers:{'User-Agent':USER_AGENT,'Accept':'application/json'},
        signal:controller.signal,redirect:'error'
      });
      const ct=response.headers.get('content-type')||'';
      const retryAfter=response.headers.get('retry-after');
      const retrySeconds=retryAfter&&/^\d+$/.test(retryAfter)?Number(retryAfter):null;
      const text=await response.text();
      if(text.length>5_000_000)return {status:502,body:JSON.stringify({error:'검색 응답 크기 제한 초과'})};
      if(response.ok){
        if(!ct.includes('json'))return {status:502,body:JSON.stringify({error:'검색 서비스가 JSON 아닌 내용을 반환했습니다.'})};
        try{
          const data=JSON.parse(text);
          if(data.error){
            const code=data.error.code||'api-error';
            const transient=['maxlag','ratelimited','readonly','internal_api_error_DBConnectionError'].includes(code);
            last={status:transient?503:502,body:JSON.stringify({error:'검색 서비스 오류: '+(data.error.info||code)})};
            if(transient && attempt===0){await sleep(900);continue;}
            return last;
          }
        }catch(e){if(!(e instanceof SyntaxError))throw e;return {status:502,body:JSON.stringify({error:'검색 서비스의 JSON 응답을 읽지 못했습니다.'})};}
        return {status:200,body:text};
      }
      last={status:response.status===429?429:502,
        body:JSON.stringify({error:response.status===429?'검색 서비스 요청 제한(429). 잠시 후 다시 시도해 주세요.':'검색 서비스 HTTP '+response.status})};
      if(attempt===0 && [429,500,502,503,504].includes(response.status)){
        // Retry-After가 길면 요청 제한을 존중하여 즉시 실패 안내
        if(response.status===429 && retryAfter && (retrySeconds===null || retrySeconds>4))return last;
        await sleep(response.status===429?Math.max(1000,(retrySeconds||1)*1000):950);
        continue;
      }
      return last;
    }catch(e){
      last={status:502,body:JSON.stringify({error:e.name==='AbortError'?'검색 API 응답 시간 초과':'외부 검색 연결 실패'})};
      if(attempt===0){await sleep(700);continue;}
      return last;
    }finally{clearTimeout(timer);}
  }
  return last;
}
function fetchQueued(url){
  const cached=cacheGet(url);if(cached)return Promise.resolve(cached);
  const current=inFlight.get(url);if(current)return current;
  const promise=schedule(()=>callUpstream(url)).then(result=>{
    if(result.status===200)cachePut(url,result);
    return result;
  }).finally(()=>inFlight.delete(url));
  inFlight.set(url,promise);
  return promise;
}
const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url||'/',`http://localhost:${PORT}`);
    if(req.method==='HEAD'&&(u.pathname==='/'||u.pathname==='/health')){
      res.writeHead(200,{...common,'Content-Type':u.pathname==='/'?'text/html; charset=utf-8':'application/json; charset=utf-8'});
      return res.end();
    }
    if(req.method!=='GET')return send(res,405,JSON.stringify({error:'GET만 지원합니다.'}));
    if((req.url||'').length>6500)return send(res,414,JSON.stringify({error:'요청 주소가 너무 깁니다.'}));
    if(u.pathname==='/')return send(res,200,html,'text/html; charset=utf-8');
    if(u.pathname==='/health')return send(res,200,JSON.stringify({ok:true,app:'mygorithm-content-explorer',version:'v7'}));
    if(u.pathname!=='/api/proxy')return send(res,404,JSON.stringify({error:'찾을 수 없습니다.'}));
    const raw=u.searchParams.get('url');
    if(!raw || raw.length>3000)return send(res,400,JSON.stringify({error:'검색 요청 주소가 없거나 너무 깁니다.'}));
    let target;
    try{target=new URL(raw);}catch{return send(res,400,JSON.stringify({error:'검색 주소가 올바르지 않습니다.'}));}
    if(target.protocol!=='https:'||target.port||target.username||target.password||allowed.get(target.hostname)!==target.pathname){
      return send(res,403,JSON.stringify({error:'허용되지 않은 검색 주소입니다.'}));
    }
    // 정해진 위키미디어 검색 API만 중계. 그 외의 웹사이트는 호출하지 않음.
    const response=await fetchQueued(target.href);
    send(res,response.status,response.body);
  }catch(e){
    send(res,502,JSON.stringify({error:'검색 서버 처리 오류: '+e.message}));
  }
});
server.listen(PORT,HOST,()=>console.log(`맘고리즘 탐색기 v7: http://${HOST}:${PORT}`));
