/**
 * ─────────────────────────────────────────────────────────────────
 *  dhan-proxy.js  v4.0  —  CORS-free Proxy + Scrip Lookup + App Server
 *  No npm install needed. Uses only Node.js built-in modules.
 * ─────────────────────────────────────────────────────────────────
 *  HOW TO RUN:
 *    1. Install Node.js (LTS) from https://nodejs.org
 *    2. Put THIS FILE + monthly-investment-strategy.html in the SAME folder
 *    3. Open Terminal:  node dhan-proxy.js
 *    4. Browser opens automatically at http://localhost:8080
 *    5. Keep terminal open. Ctrl+C to stop.
 *
 *  KEY FIX (CORS "Invalid CORS request"):
 *    Only auth headers are forwarded to Dhan. Browser headers
 *    (Origin, Referer, sec-*) are NEVER sent — they cause Dhan's
 *    "Invalid CORS request" rejection.
 *
 *  ROUTES:
 *    GET /            → serves monthly-investment-strategy.html
 *    GET /health      → {status:"ok"}
 *    GET /scrip-lookup?symbols=GOLDBEES,MON100,SILVERBEES
 *                     → fetches Dhan scrip master, returns security IDs
 *    GET /scrip-lookup?isins=INF204KC1402,...
 *                     → ISIN-based lookup using detailed CSV
 *    everything else  → forwarded to api.dhan.co or sandbox.dhan.co
 * ─────────────────────────────────────────────────────────────────
 */

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { exec } = require('child_process');

const PORT = 8080;
const LOG  = path.join(__dirname, 'dhan-proxy.log');
const HTML = path.join(__dirname, 'monthly-investment-strategy.html');

const SCRIP_COMPACT  = 'https://images.dhan.co/api-data/api-scrip-master.csv';
const SCRIP_DETAILED = 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
  process.stdout.write(line);
  try { fs.appendFileSync(LOG, line); } catch(e) {}
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? `open "${url}"` :
              process.platform === 'win32'  ? `start "" "${url}"` :
                                              `xdg-open "${url}"`;
  exec(cmd, err => { if(err) log('Could not auto-open browser: ' + err.message); });
}

/* ── Scrip master in-memory cache (1-hour TTL) ── */
const cache = { compact: null, compactAt: 0, detailed: null, detailedAt: 0 };
const CACHE_TTL = 3600000;

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    log('  Downloading ' + url);
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const s = Buffer.concat(chunks).toString('utf8');
        log('  Done: ' + Math.round(s.length/1024) + ' KB');
        resolve(s);
      });
    }).on('error', reject);
  });
}

async function getCompact() {
  if (cache.compact && Date.now()-cache.compactAt < CACHE_TTL) return cache.compact;
  cache.compact = await fetchUrl(SCRIP_COMPACT);
  cache.compactAt = Date.now();
  return cache.compact;
}

async function getDetailed() {
  if (cache.detailed && Date.now()-cache.detailedAt < CACHE_TTL) return cache.detailed;
  cache.detailed = await fetchUrl(SCRIP_DETAILED);
  cache.detailedAt = Date.now();
  return cache.detailed;
}

/* ── CSV parser (handles quoted commas) ── */
function parseLine(line) {
  const r = []; let cur='', inQ=false;
  for(let i=0; i<line.length; i++){
    const c=line[i];
    if(c==='"') inQ=!inQ;
    else if(c===','&&!inQ){r.push(cur.trim());cur='';}
    else cur+=c;
  }
  r.push(cur.trim()); return r;
}

/* ── Lookup by NSE trading symbol in compact CSV ── */
async function lookupBySymbols(symbols) {
  const csv = await getCompact();
  const lines = csv.split('\n');
  const hdr = parseLine(lines[0]);
  const iExch=hdr.indexOf('SEM_EXM_EXCH_ID'), iSeg=hdr.indexOf('SEM_SEGMENT'),
        iSecId=hdr.indexOf('SEM_SMST_SECURITY_ID'), iTradSym=hdr.indexOf('SEM_TRADING_SYMBOL'),
        iDisp=hdr.indexOf('SEM_CUSTOM_SYMBOL'), iSeries=hdr.indexOf('SEM_SERIES'),
        iInstr=hdr.indexOf('SEM_INSTRUMENT_NAME'), iLot=hdr.indexOf('SEM_LOT_UNITS');
  log('  Compact header (0-9): ' + hdr.slice(0,10).join(' | '));
  const wanted = new Set(symbols.map(s=>s.toUpperCase()));
  const out = {};
  for(let i=1; i<lines.length; i++){
    if(!lines[i].trim()) continue;
    const c=parseLine(lines[i]);
    if((c[iExch]||'')!=='NSE'||(c[iSeg]||'')!=='E') continue;
    const sym=(c[iTradSym]||'').toUpperCase();
    if(wanted.has(sym)){
      out[sym]={securityId:c[iSecId]||'',tradingSymbol:c[iTradSym]||'',
                displayName:c[iDisp]||'',series:c[iSeries]||'',
                instrument:c[iInstr]||'',lotSize:c[iLot]||'1'};
      if(Object.keys(out).length===wanted.size) break;
    }
  }
  return out;
}

/* ── Lookup by ISIN in detailed CSV (handles mutual funds & ETFs) ── */
async function lookupByISINs(isins) {
  const csv = await getDetailed();
  const lines = csv.split('\n');
  const hdr = parseLine(lines[0]);
  log('  Detailed header (0-12): ' + hdr.slice(0,12).join(' | '));
  const iISIN=hdr.indexOf('ISIN'), iExch=hdr.indexOf('EXCH_ID'), iSeg=hdr.indexOf('SEGMENT');
  const iSecId=hdr.findIndex(h=>h.includes('SECURITY_ID'));
  const iTrad=hdr.indexOf('SYMBOL_NAME')!==-1?hdr.indexOf('SYMBOL_NAME'):hdr.findIndex(h=>h.includes('SYMBOL'));
  const iDisp=hdr.indexOf('DISPLAY_NAME');
  const iSeries=hdr.indexOf('SERIES'), iInstr=hdr.indexOf('INSTRUMENT');
  const wanted = new Set(isins.map(s=>s.toUpperCase().trim()));
  const out = {};
  for(let i=1; i<lines.length; i++){
    if(!lines[i].trim()) continue;
    const c=parseLine(lines[i]);
    const isin=(c[iISIN]||'').toUpperCase().trim();
    if(!wanted.has(isin)) continue;
    const exch=c[iExch]||'', seg=c[iSeg]||'';
    const isNSE=(exch==='NSE'&&seg==='E');
    const isBSE=(exch==='BSE'&&seg==='E');
    const ex=out[isin];
    if(!ex||(!ex._nse&&isNSE)||(!ex._nse&&!ex._bse&&isBSE)){
      out[isin]={securityId:c[iSecId]||'',tradingSymbol:c[iTrad]||'',
                 displayName:iDisp>=0?c[iDisp]:'',series:iSeries>=0?c[iSeries]:'',
                 instrument:iInstr>=0?c[iInstr]:'',exchange:exch,segment:seg,
                 _nse:isNSE,_bse:isBSE};
    }
    if(Object.keys(out).length===wanted.size&&Object.values(out).every(r=>r._nse)) break;
  }
  return out;
}

/* ── Safe forward headers (strip all browser headers) ── */
function fwdHeaders(req, host) {
  const h={'Content-Type':'application/json','Accept':'application/json','Host':host};
  const at=req.headers['access-token']||req.headers['Access-Token'];
  const cid=req.headers['dhanclientid']||req.headers['dhanClientId']||req.headers['client-id'];
  if(at) h['access-token']=at;
  if(cid) h['dhanClientId']=cid;
  return h;
}

/* ═══════════════════════ HTTP SERVER ═══════════════════════════ */
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,access-token,dhanClientId,client-id,Authorization,X-Dhan-Host');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}

  const [urlPath,qs]=(req.url+'').split('?');
  log(req.method+' '+req.url);

  /* Serve HTML */
  if(urlPath==='/'||urlPath==='/index.html'){
    fs.readFile(HTML,(err,data)=>{
      if(err){res.writeHead(404,{'Content-Type':'text/html'});
        res.end('<h2>monthly-investment-strategy.html not found</h2><p>Place both files in the same folder as dhan-proxy.js: '+__dirname+'</p>');return;}
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end(data);
    });
    return;
  }

  /* Health */
  if(urlPath==='/health'){
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'ok',proxy:'Dhan Proxy',version:'4.0',port:PORT}));
    return;
  }

  /* AMFI NAV lookup: /amfi-nav?isins=INF789F1AB22,INF879O01027
     Fetches India's official daily NAV from amfiindia.com and returns
     a map of { ISIN: { nav, date, schemeName } }                       */
  if(urlPath==='/amfi-nav'){
    const params={};
    if(qs) qs.split('&').forEach(p=>{const[k,v]=p.split('=');params[decodeURIComponent(k)]=decodeURIComponent(v||'');});
    const wanted=new Set((params.isins||'').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean));
    if(!wanted.size){
      res.writeHead(400,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Provide isins query param'}));
      return;
    }
    log('→ AMFI NAV for: '+[...wanted].join(', '));
    https.get('https://www.amfiindia.com/spages/NAVAll.txt',{headers:{'User-Agent':'Mozilla/5.0'}},csv=>{
      const chunks=[];
      csv.on('data',c=>chunks.push(c));
      csv.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');
        const lines=text.split('\n');
        const out={};
        // NAVAll.txt format: SchemeCode;ISINGrowth;ISINDiv;SchemeName;NavDate;NAV
        for(const line of lines){
          const parts=line.split(';');
          if(parts.length<6) continue;
          const isin1=(parts[1]||'').trim().toUpperCase();
          const isin2=(parts[2]||'').trim().toUpperCase();
          const nav=parseFloat(parts[5])||0;
          const date=(parts[4]||'').trim();
          const name=(parts[3]||'').trim();
          if(wanted.has(isin1)&&!out[isin1]) out[isin1]={nav,date,schemeName:name};
          if(wanted.has(isin2)&&!out[isin2]) out[isin2]={nav,date,schemeName:name};
          if(Object.keys(out).length===wanted.size) break;
        }
        log('  ← AMFI found '+Object.keys(out).length+'/'+wanted.size);
        res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify(out));
      });
    }).on('error',e=>{
      log('  ✕ AMFI error: '+e.message);
      res.writeHead(502,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message}));
    });
    return;
  }

  /* Scrip lookup */
  if(urlPath==='/scrip-lookup'){
    const params={};
    if(qs) qs.split('&').forEach(p=>{const[k,v]=p.split('=');params[decodeURIComponent(k)]=decodeURIComponent(v||'');});
    const syms=(params.symbols||'').split(',').map(s=>s.trim()).filter(Boolean);
    const ins=(params.isins||'').split(',').map(s=>s.trim()).filter(Boolean);
    const p=syms.length?lookupBySymbols(syms):lookupByISINs(ins);
    p.then(r=>{
      log('  → Scrip result keys: '+Object.keys(r).join(', '));
      res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify(r));
    }).catch(e=>{
      log('  ✕ Scrip lookup error: '+e.message);
      res.writeHead(500,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({error:e.message}));
    });
    return;
  }

  /* Forward to Dhan API */
  const dhanHost=req.headers['x-dhan-host']||'api.dhan.co';
  const headers=fwdHeaders(req,dhanHost);
  let body='';
  req.on('data',c=>{body+=c;});
  req.on('end',()=>{
    log('  → https://'+dhanHost+req.url);
    const pr=https.request({hostname:dhanHost,port:443,path:req.url,method:req.method,headers,timeout:20000},(r)=>{
      log('  ← '+r.statusCode);
      res.writeHead(r.statusCode,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      r.pipe(res);
    });
    pr.on('timeout',()=>{pr.destroy();if(!res.headersSent){res.writeHead(504,{'Content-Type':'application/json'});res.end(JSON.stringify({errorType:'Timeout',errorMessage:'Dhan API timed out'}));}});
    pr.on('error',e=>{log('  ✕ '+e.message);if(!res.headersSent){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({errorType:'ProxyError',errorMessage:e.message}));}});
    if(body&&(req.method==='POST'||req.method==='PUT'||req.method==='PATCH')) pr.write(body);
    pr.end();
  });

}).listen(PORT,'127.0.0.1',()=>{
  const url='http://localhost:'+PORT;
  console.log('\n'+'─'.repeat(60));
  console.log('  ✅  Dhan Proxy v4.0 running');
  console.log('  App    →  '+url);
  console.log('  AMFI   →  '+url+'/amfi-nav?isins=INF789F1AB22,INF879O01027');
  console.log('  Scrip  →  '+url+'/scrip-lookup?symbols=GOLDBEES,MON100');
  console.log('  Health →  '+url+'/health');
  console.log('  ⚠️  Keep this terminal open. Ctrl+C to stop.');
  console.log('─'.repeat(60)+'\n');
  log('Proxy started: '+url);
  setTimeout(()=>{console.log('  🌐 Opening browser…\n');openBrowser(url);},500);
}).on('error',err=>{
  if(err.code==='EADDRINUSE'){console.error('\n❌  Port '+PORT+' already in use. Stop whatever is running on it.\n');}
  else console.error('❌  Server error:',err.message);
  process.exit(1);
});
