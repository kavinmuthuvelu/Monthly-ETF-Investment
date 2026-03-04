/**
 * dhan-proxy.js  —  Local CORS proxy for Monthly Investment Strategy App
 *
 * Run: node dhan-proxy.js
 * Default port: 8080
 *
 * Routes:
 *   GET  /health                    — health check
 *   GET  /dhan-mf-nav?slug=<slug>   — scrape NAV from Dhan MF page (SSR HTML)
 *   *    /v2/*                      — forward to api.dhan.co (requires token headers)
 */

const http  = require("http");
const https = require("https");
const url   = require("url");
const fs    = require("fs");
const path  = require("path");

// Serve the app HTML — look for it next to this proxy file
const HTML_CANDIDATES = [
  path.join(__dirname, "monthly-investment-strategy-v3.html"),
  path.join(__dirname, "index.html"),
  path.join(__dirname, "app.html"),
];
let APP_HTML = null;
for(const p of HTML_CANDIDATES){
  try{ APP_HTML = fs.readFileSync(p, "utf8"); console.log("Serving HTML from:", p); break; }
  catch{}
}
if(!APP_HTML) console.warn("⚠️  No HTML file found — place monthly-investment-strategy-v3.html next to dhan-proxy.js");

const PORT        = parseInt(process.env.PORT || "8080");
const DHAN_API    = "api.dhan.co";
const DHAN_WEB    = "dhan.co";

// ── helpers ──────────────────────────────────────────────────────────────────

function httpsGet(hostname, path, headers={}, timeout=10000){
  return new Promise((resolve, reject)=>{
    const opts = { hostname, path, method:"GET",
      headers:{ "User-Agent":"Mozilla/5.0 (compatible; dhan-proxy/2.0)", ...headers }
    };
    const req = https.request(opts, res=>{
      let body="";
      res.setEncoding("utf8");
      res.on("data", d=>{ body+=d; });
      res.on("end", ()=>resolve({ status:res.statusCode, body }));
    });
    req.setTimeout(timeout, ()=>{ req.destroy(); reject(new Error("Request timeout")); });
    req.on("error", reject);
    req.end();
  });
}

function cors(res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","*");
}

function json(res, data, status=200){
  cors(res);
  res.writeHead(status, {"Content-Type":"application/json"});
  res.end(JSON.stringify(data));
}

// ── NAV scraper: parse Dhan MF page SSR HTML ──────────────────────────────────
function parseNavFromDhanHtml(html){
  // Dhan MF pages (Next.js SSR) embed NAV as plain text in the rendered HTML.
  // Pattern 1: "NAV (₹) on DD MMM YYYY\n\n10.6158"
  // Pattern 2: "current NAV stands at ₹10.6158 as of"
  // Pattern 3: window.__NEXT_DATA__ JSON blob

  // Try JSON first (most reliable)
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(\{[\s\S]*?\})<\/script>/);
  if(nextDataMatch){
    try{
      const nd = JSON.parse(nextDataMatch[1]);
      // Walk the page props for NAV data
      const str = JSON.stringify(nd);
      const navMatch = str.match(/"nav":\s*"?(\d+\.?\d*)"?/);
      const dateMatch= str.match(/"navDate":\s*"([^"]+)"/);
      const nameMatch= str.match(/"schemeName":\s*"([^"]+)"/);
      if(navMatch){
        return {
          nav:  parseFloat(navMatch[1]),
          date: dateMatch?.[1] || "",
          name: nameMatch?.[1] || ""
        };
      }
    } catch(e){ /* continue to text parsing */ }
  }

  // Text pattern: look for NAV number near "NAV" keyword
  const navLineMatch = html.match(/NAV\s*\(₹\)[^<]*?\n+\s*(\d+\.\d+)/);
  if(navLineMatch) {
    const dateMatch = html.match(/NAV \(₹\) on ([^<\n]+)/);
    const nameMatch = html.match(/<h1[^>]*>\s*([^<]+)\s*<\/h1>/);
    return {
      nav:  parseFloat(navLineMatch[1]),
      date: dateMatch?.[1]?.trim() || "",
      name: nameMatch?.[1]?.trim() || ""
    };
  }

  // Fallback text: "current NAV stands at ₹10.6158"
  const inlineMatch = html.match(/current NAV stands at ₹(\d+\.\d+)/i);
  if(inlineMatch){
    const dateMatch = html.match(/as of (\d+ \w+ \d+)/i);
    const nameMatch = html.match(/<h1[^>]*>\s*([^<]+)\s*<\/h1>/);
    return {
      nav:  parseFloat(inlineMatch[1]),
      date: dateMatch?.[1]?.trim() || "",
      name: nameMatch?.[1]?.trim() || ""
    };
  }

  return null;
}

// ── request handler ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res)=>{
  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;

  // Preflight
  if(req.method==="OPTIONS"){ cors(res); res.writeHead(204); res.end(); return; }

  if(path==="/health"){
    return json(res, { proxy:"dhan-proxy/2.0", port:PORT, status:"ok" });
  }

  // ── /amfi-nav?isins=ISIN1,ISIN2 — fetch AMFI NAVAll.txt and return matched NAVs ──
  if(path==="/amfi-nav"){
    const isinStr = (parsed.query.isins||"").toUpperCase();
    const wantedIsins = new Set(isinStr.split(",").map(s=>s.trim()).filter(Boolean));
    if(!wantedIsins.size) return json(res, {error:"Missing isins param"}, 400);
    try{
      console.log("[amfi-nav] Fetching NAVAll.txt for ISINs:", [...wantedIsins].join(", "));
      const r = await httpsGet("www.amfiindia.com", "/spages/NAVAll.txt", {
        "Accept": "text/plain",
        "Accept-Encoding": "identity",
      }, 20000);
      if(r.status!==200) throw new Error("AMFI returned HTTP "+r.status);
      const result = {};
      for(const line of r.body.split("\n")){
        const parts = line.split(";");
        if(parts.length < 6) continue;
        const [code, isinG, isinD, name, nav, date] = parts.map(s=>s.trim());
        const navF = parseFloat(nav);
        if(!navF || isNaN(navF)) continue;
        [isinG, isinD].forEach(isin=>{
          if(isin && wantedIsins.has(isin.toUpperCase())){
            result[isin.toUpperCase()] = {nav:navF, date, schemeName:name, schemeCode:code};
          }
        });
      }
      console.log(`[amfi-nav] Matched ${Object.keys(result).length}/${wantedIsins.size} ISINs`);
      return json(res, result);
    } catch(e){
      console.error("[amfi-nav] Error:", e.message);
      return json(res, {error:e.message}, 502);
    }
  }

  // ── /dhan-mf-nav?slug=<slug> ───────────────────────────────────────────────
  if(path==="/dhan-mf-nav"){
    const slug = (parsed.query.slug||"").replace(/[^a-z0-9\-]/gi,"");
    if(!slug) return json(res, {error:"Missing slug"}, 400);

    try{
      const mfPath = `/mutual-funds/${slug}/`;
      console.log(`[dhan-mf-nav] Fetching https://${DHAN_WEB}${mfPath}`);
      const r = await httpsGet(DHAN_WEB, mfPath, {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
        "Cache-Control": "no-cache"
      });

      if(r.status!==200) throw new Error(`Dhan page returned HTTP ${r.status}`);

      const navData = parseNavFromDhanHtml(r.body);
      if(!navData || !navData.nav || isNaN(navData.nav)){
        // Dump first 2000 chars for debugging
        console.error("[dhan-mf-nav] Could not parse NAV. HTML snippet:\n", r.body.slice(0,2000));
        return json(res, { error:"Could not parse NAV from page", slug }, 502);
      }

      console.log(`[dhan-mf-nav] ${slug} → NAV=₹${navData.nav} (${navData.date})`);
      return json(res, navData);

    } catch(e){
      console.error("[dhan-mf-nav] Error:", e.message);
      return json(res, { error:e.message }, 502);
    }
  }

  // ── /v2/* → forward to api.dhan.co ────────────────────────────────────────
  if(path.startsWith("/v2/") || path.startsWith("/v1/")){
    let body = "";
    req.on("data", d=>{ body+=d; });
    req.on("end", async ()=>{
      try{
        const fwdHeaders = {
          "Content-Type": "application/json",
          "access-token":  req.headers["access-token"]  || "",
          "client-id":     req.headers["client-id"]     || "",
          "X-Dhan-Host":   req.headers["x-dhan-host"]   || "api.dhan.co",
        };
        const opts = {
          hostname: DHAN_API,
          path:     req.url,
          method:   req.method,
          headers:  fwdHeaders
        };
        const upstream = await new Promise((resolve, reject)=>{
          const ureq = https.request(opts, ures=>{
            let d="";
            ures.setEncoding("utf8");
            ures.on("data", c=>{ d+=c; });
            ures.on("end", ()=>resolve({ status:ures.statusCode, body:d }));
          });
          ureq.setTimeout(15000, ()=>{ ureq.destroy(); reject(new Error("Upstream timeout")); });
          ureq.on("error", reject);
          if(body) ureq.write(body);
          ureq.end();
        });

        cors(res);
        res.writeHead(upstream.status, {"Content-Type":"application/json"});
        res.end(upstream.body);
      } catch(e){
        console.error("[proxy] Forward error:", e.message);
        json(res, { error:e.message }, 502);
      }
    });
    return;
  }

  // ── / and /index.html → serve the app ────────────────────────────────────
  if(path==="/"||path===""||path==="/index.html"||path==="/app.html"){
    if(APP_HTML){
      cors(res);
      res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});
      return res.end(APP_HTML);
    }
    // No HTML file found — fall through to health JSON
    return json(res, { proxy:"dhan-proxy/2.0", port:PORT, status:"ok",
      warning:"Place monthly-investment-strategy-v3.html next to dhan-proxy.js to serve the app" });
  }

  // ── /health ────────────────────────────────────────────────────────────────
  // (keep explicit /health so Render's health checks still work)

  // 404
  json(res, { error:"Unknown route", path }, 404);
});

server.listen(PORT, ()=>{
  console.log(`\n✓ dhan-proxy running on http://localhost:${PORT}`);
  console.log(`  Routes:`);
  console.log(`    GET  /health`);
  console.log(`    GET  /dhan-mf-nav?slug=<dhan-mf-page-slug>`);
  console.log(`    *    /v2/* → api.dhan.co\n`);
});

server.on("error", e=>{
  if(e.code==="EADDRINUSE") console.error(`Port ${PORT} already in use. Set PORT= env var to use a different port.`);
  else console.error("Server error:", e);
});
