#!/usr/bin/env node
/* Wallex Desk — news monitor. Node, zero deps.
 * Fetches RSS/announcement sources, finds NEW items vs telegram/state/seen.json,
 * asks an OpenAI-compatible LLM (GLM/z.ai etc.) to pick the genuinely interesting
 * ones and rewrite them as Persian Telegram posts in Wallex voice, then sends them
 * to the private channel and records what was seen. Env:
 *   LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *   (optional) MAX_CANDIDATES=10  MAX_POSTS=3  DRY=1 (don't send/commit, just print) */
const fs = require("fs"), path = require("path"), https = require("https");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const SEEN = path.join(ROOT, "telegram", "state", "seen.json");
const MAX_CANDIDATES = +(process.env.MAX_CANDIDATES || 10);
const MAX_POSTS = +(process.env.MAX_POSTS || 3);
const DRY = process.env.DRY === "1";

const SOURCES = [
  { id: "cointelegraph",   name: "Cointelegraph",    type: "rss", url: "https://cointelegraph.com/rss" },
  { id: "coindesk",        name: "CoinDesk",         type: "rss", url: "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml" },
  { id: "cryptonews",      name: "CryptoNews",       type: "rss", url: "https://cryptonews.com/feed/" },
  { id: "bitcoinmagazine", name: "Bitcoin Magazine", type: "rss", url: "https://bitcoinmagazine.com/feed" },
  { id: "binance",         name: "Binance",          type: "binance" },
  { id: "kucoin",          name: "KuCoin",           type: "kucoin" },
];

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(u, {
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WallexDeskBot/1.0)", "Accept": "*/*" },
      timeout: 25000,
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && redirects < 4) {
        res.resume(); return resolve(get(new URL(res.headers.location, url).href, redirects+1));
      }
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout"))); req.end();
  });
}

const strip = s => (s||"").replace(/<!\[CDATA\[|\]\]>/g,"").replace(/<[^>]+>/g," ").replace(/&[a-z#0-9]+;/gi," ").replace(/\s+/g," ").trim();
function tag(block, name){ const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i")); return m ? m[1] : ""; }

function parseRSS(xml, src) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    let link = strip(tag(b, "link"));
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); if (m) link = m[1]; }
    const title = strip(tag(b, "title"));
    const date = strip(tag(b, "pubDate")) || strip(tag(b, "published")) || strip(tag(b, "updated"));
    const summary = strip(tag(b, "description") || tag(b, "summary") || tag(b, "content")).slice(0, 400);
    if (title && link) items.push({ src: src.id, srcName: src.name, id: link, title, link, summary, ts: date ? Date.parse(date) || Date.now() : Date.now() });
  }
  return items;
}

async function fetchSource(src) {
  try {
    if (src.type === "rss") { const r = await get(src.url); if (r.status !== 200) return []; return parseRSS(r.body, src); }
    if (src.type === "binance") {
      const r = await get("https://www.binance.com/bapi/composite/v1/public/cms/article/catalog/list/query?catalogId=48&pageNo=1&pageSize=15");
      const j = JSON.parse(r.body); const arts = (((j.data||{}).catalogs||[])[0]||{}).articles || j.data?.articles || [];
      return arts.map(a => ({ src:"binance", srcName:"Binance", id:String(a.code||a.id), title:strip(a.title),
        link:`https://www.binance.com/en/support/announcement/${a.code}`, summary:"", ts:a.releaseDate||Date.now() }));
    }
    if (src.type === "kucoin") {
      const r = await get("https://www.kucoin.com/_api/cms/articles?category=announcements&lang=en_US&page=1&pageSize=15");
      const j = JSON.parse(r.body); const arts = (j.items || j.data?.items || []);
      return arts.map(a => ({ src:"kucoin", srcName:"KuCoin", id:String(a.id||a.path), title:strip(a.title),
        link:`https://www.kucoin.com/announcement${a.path||""}`, summary:strip(a.summary||""), ts:a.publish_ts||Date.parse(a.createdAt)||Date.now() }));
    }
  } catch (e) { console.log(`[warn] source ${src.id} failed: ${e.message}`); }
  return [];
}

function loadSeen(){ try { return JSON.parse(fs.readFileSync(SEEN,"utf8")); } catch { return {}; } }
function saveSeen(seen){ fs.mkdirSync(path.dirname(SEEN),{recursive:true}); fs.writeFileSync(SEEN, JSON.stringify(seen)); }

const SYSTEM = `تو دسک بازار والکس هستی، صرافی ارز دیجیتال ایرانی، و برای کانال تلگرام تیم پست خبری فارسی می‌سازی.
از میان خبرهایی که می‌دهم، فقط مواردی را انتخاب کن که واقعا برای کاربر ایرانی کریپتو مهم یا جالب‌اند: خبر بزرگ بازار، تصمیم نهاد ناظر، لیست‌شدن مهم، رویداد کلان اثرگذار. خبرهای کم‌اهمیت یا تکراری یا صرفا تبلیغاتی را رد کن. اگر هیچ‌کدام واقعا ارزش انتشار ندارند، آرایه خالی برگردان.
برای هر خبر انتخاب‌شده یک پست تلگرام فارسی بنویس با این قواعد:
- لحن حرفه‌ای و مطمئن مثل یک تریدر کارکشته، ولی ساده و همه‌فهم. بدون هیجان و بزرگ‌نمایی.
- ۶۰ تا ۱۴۰ کلمه. یک ایموجی فقط ابتدای تیتر.
- هرجا اسم ارز آوردی معادل انگلیسی داخل پرانتز بیاور، مثل بیت‌کوین (Bitcoin).
- خط قرمز: قیمت تتر ننویس. سیگنال خرید و فروش و هدف قیمتی و وعده سود ممنوع. نام صرافی رقیب ایرانی نبر. ادعای بی‌منبع نساز. خبر را فقط گزارش و تحلیل کوتاه کن، نه توصیه.
- نگارش: خط تیره بلند ممنوع، ویرگول. بدون تنوین، دقیقا نه دقیقاً. اعداد فارسی. جمله کوتاه. لینک داخل متن نگذار، من خودم منبع را ته پست اضافه می‌کنم.
خروجی فقط و فقط یک آرایه JSON معتبر، بدون هیچ متن اضافه، به این شکل:
[{"id":"<همان id ورودی>","text":"<متن کامل پست فارسی>"}]`;

async function callLLM(cands){
  const base = process.env.LLM_BASE_URL, key = process.env.LLM_API_KEY, model = process.env.LLM_MODEL;
  const list = cands.map((c,i)=>`(${i+1}) id=${c.id}\nمنبع: ${c.srcName}\nتیتر: ${c.title}\nخلاصه: ${c.summary||"-"}`).join("\n\n");
  const body = JSON.stringify({ model, temperature: 0.4, max_tokens: 2200,
    messages: [ {role:"system", content: SYSTEM},
      {role:"user", content: `این خبرهای تازه است. حداکثر ${MAX_POSTS} مورد از بهترین‌ها را انتخاب کن و پست بساز.\n\n${list}`} ] });
  const u = new URL(base.replace(/\/$/,"") + "/chat/completions");
  const raw = await new Promise((resolve,reject)=>{
    const req = https.request(u,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`,"Content-Length":Buffer.byteLength(body)},timeout:60000},
      res=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>resolve(d));});
    req.on("error",reject); req.on("timeout",()=>req.destroy(new Error("llm timeout"))); req.write(body); req.end();
  });
  let content;
  try { content = JSON.parse(raw).choices[0].message.content; }
  catch(e){ throw new Error("bad LLM response: " + raw.slice(0,300)); }
  const m = content.match(/\[[\s\S]*\]/); if (!m) return [];
  return JSON.parse(m[0]);
}

function tgSend(text){
  const tok=process.env.TELEGRAM_BOT_TOKEN, chat=process.env.TELEGRAM_CHAT_ID;
  const body=JSON.stringify({chat_id:chat,text,disable_web_page_preview:false});
  return new Promise((resolve,reject)=>{
    const req=https.request(`https://api.telegram.org/bot${tok}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},
      r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{let j={};try{j=JSON.parse(d);}catch{} j.ok?resolve():reject(new Error(d));});});
    req.on("error",reject); req.write(body); req.end();
  });
}

(async()=>{
  const seen = loadSeen();
  let all = [];
  for (const s of SOURCES) all = all.concat(await fetchSource(s));
  console.log(`fetched ${all.length} items total`);
  // new = not seen
  const cutoff = Date.now() - (+(process.env.MAX_AGE_H||48))*3600e3;
  const fresh = all.filter(it => !(seen[it.src]||[]).includes(String(it.id)) && it.ts >= cutoff);
  fresh.sort((a,b)=> b.ts - a.ts);
  const perSrc = +(process.env.PER_SOURCE||2), cnt = {}, cands = [];
  for (const it of fresh){ if((cnt[it.src]||0) >= perSrc) continue; cnt[it.src]=(cnt[it.src]||0)+1; cands.push(it); if(cands.length>=MAX_CANDIDATES) break; }
  console.log(`new items (recent): ${fresh.length}, candidates sent to LLM: ${cands.length}`);
  if (DRY) cands.forEach((c,i)=>console.log(`  [${i+1}] ${c.srcName} | ${c.title.slice(0,90)} | ${c.link.slice(0,70)}`));

  let posts = [];
  if (cands.length){
    try { posts = await callLLM(cands); } catch(e){ console.log("[error] LLM:", e.message); }
  }
  const byId = Object.fromEntries(cands.map(c=>[String(c.id), c]));
  console.log(`LLM selected ${posts.length} post(s)`);

  for (const p of posts.slice(0, MAX_POSTS)){
    const c = byId[String(p.id)];
    const text = c ? `${p.text}\n\n🔗 منبع (${c.srcName}): ${c.link}` : p.text;
    console.log("\n----- POST -----\n" + text);
    if (!DRY){ try { await tgSend(text); console.log("[sent]"); await new Promise(r=>setTimeout(r,2000)); } catch(e){ console.log("[send failed]", e.message); } }
  }

  // mark ALL fetched as seen (posted or not), cap 150 per source
  for (const it of all){ (seen[it.src] ||= []); if(!seen[it.src].includes(String(it.id))) seen[it.src].unshift(String(it.id)); seen[it.src] = seen[it.src].slice(0,150); }
  if (!DRY) saveSeen(seen);
  console.log("\ndone" + (DRY ? " (dry run, nothing sent/saved)" : ""));
})();
