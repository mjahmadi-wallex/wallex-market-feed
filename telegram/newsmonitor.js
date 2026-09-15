#!/usr/bin/env node
/* Wallex Desk — news monitor (two-stage: select hot -> write long post). Node, zero deps.
 * Env: LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *      MAX_POSTS(=15) MAX_CANDIDATES(=40) PER_SOURCE(=10) MAX_AGE_H(=48) IGNORE_SEEN DRY */
const fs = require("fs"), path = require("path"), https = require("https");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const SEEN = path.join(ROOT, "telegram", "state", "seen.json");
const MAX_POSTS = +(process.env.MAX_POSTS || 15);
const MAX_CANDIDATES = +(process.env.MAX_CANDIDATES || 40);
const PER_SOURCE = +(process.env.PER_SOURCE || 10);
const DRY = process.env.DRY === "1";

const SOURCES = [
  { id: "cointelegraph",   name: "Cointelegraph",    type: "rss", url: "https://cointelegraph.com/rss" },
  { id: "coindesk",        name: "CoinDesk",         type: "rss", url: "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml" },
  { id: "cryptonews",      name: "CryptoNews",       type: "rss", url: "https://cryptonews.com/feed/" },
  { id: "bitcoinmagazine", name: "Bitcoin Magazine", type: "rss", url: "https://bitcoinmagazine.com/feed" },
  { id: "binance",         name: "Binance",          type: "binance" },
  { id: "kucoin",          name: "KuCoin",           type: "kucoin" },
];

const FA = "۰۱۲۳۴۵۶۷۸۹";
const fa = s => String(s).replace(/[0-9]/g, d => FA[d]);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function g2j(gy,gm,gd){const gdm=[0,31,59,90,120,151,181,212,243,273,304,334];let jy;if(gy>1600){jy=979;gy-=1600;}else{jy=0;gy-=621;}const gy2=gm>2?gy+1:gy;let days=365*gy+Math.floor((gy2+3)/4)-Math.floor((gy2+99)/100)+Math.floor((gy2+399)/400)-80+gd+gdm[gm-1];jy+=33*Math.floor(days/12053);days%=12053;jy+=4*Math.floor(days/1461);days%=1461;if(days>365){jy+=Math.floor((days-1)/365);days=(days-1)%365;}let jm,jd;if(days<186){jm=1+Math.floor(days/31);jd=1+(days%31);}else{jm=7+Math.floor((days-186)/30);jd=1+((days-186)%30);}return[jy,jm,jd];}
const JM=["فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور","مهر","آبان","آذر","دی","بهمن","اسفند"];
function tehranStamp(ms){const t=new Date(ms+(3*60+30)*60000);const[jy,jm,jd]=g2j(t.getUTCFullYear(),t.getUTCMonth()+1,t.getUTCDate());const hhmm=fa(`${String(t.getUTCHours()).padStart(2,"0")}:${String(t.getUTCMinutes()).padStart(2,"0")}`);return `${hhmm}، ${fa(jd)} ${JM[jm-1]}`;}
function ago(ms){const m=Math.max(0,Math.round((Date.now()-ms)/60000));if(m<60)return `${fa(m)} دقیقه پیش`;const h=Math.floor(m/60),r=m%60;if(h<24)return r?`${fa(h)} ساعت و ${fa(r)} دقیقه پیش`:`${fa(h)} ساعت پیش`;return `${fa(Math.floor(h/24))} روز پیش`;}
function pct(v,dec=1){return fa(Math.abs(v).toFixed(dec)).replace(".","٫");}
function price(p){const ap=Math.abs(p);let s;if(ap>=1000)s=Math.round(p).toLocaleString("en-US");else if(ap>=1)s=p.toFixed(2);else if(ap>=0.01)s=p.toFixed(4);else s=p.toFixed(8).replace(/0+$/,"").replace(/\.$/,"");return fa(s).replace(".","٫").replace(/,/g,"٬");}
function capFmt(n){if(n>=1e12)return `${fa((n/1e12).toFixed(2)).replace(".","٫")} تریلیون دلار`;if(n>=1e9)return `${fa((n/1e9).toFixed(0))} میلیارد دلار`;return `${fa(Math.round(n).toLocaleString("en-US")).replace(/,/g,"٬")} دلار`;}
function usdFmt(n){n=Number(n)||0;if(n>=1e9)return `${fa((n/1e9).toFixed(1)).replace(".","٫")} میلیارد دلار`;if(n>=1e6)return `${fa((n/1e6).toFixed(1)).replace(".","٫")} میلیون دلار`;if(n>=1e3)return `${fa((n/1e3).toFixed(0))} هزار دلار`;return `${fa(Math.round(n))} دلار`;}
async function whalePost(){
  const key=process.env.WHALE_ALERT_API_KEY;if(!key){console.log("[whale] no key, skip");return null;}
  try{
    const start=Math.floor(Date.now()/1000)-3600;
    const r=await get(`https://api.whale-alert.io/v1/transactions?api_key=${key}&min_value=500000&start=${start}&limit=40`);
    if(r.status!==200){console.log("[whale] HTTP",r.status,r.body.slice(0,150));return null;}
    const j=JSON.parse(r.body);const tx=(j.transactions||[]).filter(t=>t.amount_usd).sort((a,b)=>b.amount_usd-a.amount_usd).slice(0,8);
    if(!tx.length){console.log("[whale] no large tx in window");return null;}
    const own=o=>{if(!o)return "کیف‌پول ناشناس";if(o.owner&&o.owner_type==="exchange")return `صرافی ${o.owner}`;if(o.owner&&o.owner!=="unknown")return o.owner;return "کیف‌پول ناشناس";};
    const L=["🐋 رصد نهنگ‌ها","","بزرگ‌ترین جابه‌جایی‌های آن‌چین در یک ساعت گذشته:",""];
    for(const t of tx)L.push(`🔸 ${fa(Math.round(t.amount).toLocaleString("en-US")).replace(/,/g,"٬")} ${String(t.symbol).toUpperCase()} (${usdFmt(t.amount_usd)}) از ${own(t.from)} به ${own(t.to)}`);
    L.push("","📌 رصد جابه‌جایی‌های بزرگ برای آگاهی، نه توصیه. منبع: Whale Alert.");
    return L.join("\n");
  }catch(e){console.log("[whale] failed:",e.message);return null;}
}
async function defiLlamaHacks(seen,ignoreSeen){
  try{
    const r=await get("https://api.llama.fi/hacks");if(r.status!==200){console.log("[hacks] HTTP",r.status);return[];}
    const arr=JSON.parse(r.body);const cut=Date.now()/1000-5*86400;
    const idOf=h=>String(h.defillamaId||`${h.name}_${h.date}`);
    seen["defillama_hacks"]||=[];
    const recent=arr.filter(h=>h.date>=cut&&Number(h.amount)>0).sort((a,b)=>b.date-a.date);
    const fresh=(ignoreSeen?recent:recent.filter(h=>!seen["defillama_hacks"].includes(idOf(h)))).slice(0,3);
    const CHAINFA={Ethereum:"اتریوم",Tron:"ترون",Solana:"سولانا",BSC:"بایننس‌چین",Polygon:"پالیگان",Arbitrum:"اربیتروم",Bitcoin:"بیت‌کوین",Avalanche:"آوالانچ",Base:"بیس",Optimism:"اپتیمیزم",Fantom:"فانتوم"};
    const chFa=c=>Array.isArray(c)?c.map(x=>CHAINFA[x]||x).join("، "):(CHAINFA[c]||c);
    const posts=fresh.map(h=>{
      const lines=[`🚨 رادار امنیت، هک تازه در DeFi`,"",
        `پروتکل ${h.name}${h.chain?` روی شبکهٔ ${chFa(h.chain)}`:""} هدف حمله قرار گرفت.`,
        `💰 مبلغ آسیب: حدود ${usdFmt(h.amount)}.`];
      if(h.technique||h.classification)lines.push(`🔓 نوع حمله: ${h.technique||h.classification}.`);
      lines.push("","📌 رصد رخدادهای امنیتی برای آگاهی، نه توصیه. منبع: DefiLlama.");
      return lines.join("\n");
    });
    for(const h of recent){const id=idOf(h);if(!seen["defillama_hacks"].includes(id))seen["defillama_hacks"].unshift(id);}
    seen["defillama_hacks"]=seen["defillama_hacks"].slice(0,200);
    return posts;
  }catch(e){console.log("[hacks] failed:",e.message);return[];}
}
async function globalPost(){
  try{
    const g=JSON.parse((await get("https://api.coingecko.com/api/v3/global")).body).data;
    const tr=(JSON.parse((await get("https://api.coingecko.com/api/v3/search/trending")).body).coins)||[];
    const chg=g.market_cap_change_percentage_24h_usd;
    const L=["🌍 نبض بازار جهانی","",
      `ارزش کل بازار کریپتو حدود ${capFmt(g.total_market_cap.usd)} است، ${chg>=0?"مثبت":"منفی"} ${pct(Math.abs(chg))} درصد در ۲۴ ساعت گذشته.`,
      `دامیننس بازار: بیت‌کوین (Bitcoin) ${pct(g.market_cap_percentage.btc)} درصد، اتریوم (Ethereum) ${pct(g.market_cap_percentage.eth)} درصد.`,
      "","🔥 داغ‌ترین‌های ترند جهانی (CoinGecko)"];
    const goodTr=tr.map(c=>c.item||{}).filter(it=>it.market_cap_rank&&it.market_cap_rank<=200).slice(0,5);
    for(const it of goodTr){const d=it.data&&it.data.price_change_percentage_24h&&it.data.price_change_percentage_24h.usd;L.push(`${(d==null||d>=0)?"🟢":"🔴"} ${it.name} (${it.symbol})، رتبه ${fa(it.market_cap_rank)}${d!=null?`، ${d>=0?"مثبت":"منفی"} ${pct(Math.abs(d))} درصد`:""}`);}
    if(!goodTr.length)L.push("موردی از ترندهای معتبر در این لحظه نبود.");
    L.push("","📌 نمای کلان بازار جهانی، در کنار قیمت‌های والکس.");
    return L.join("\n");
  }catch(e){console.log("[global] failed:",e.message);return null;}
}
async function fearGreedPost(){
  const key=process.env.CMC_API_KEY;if(!key){console.log("[cmc] no key, skip fear&greed");return null;}
  try{
    const r=await getH("https://pro-api.coinmarketcap.com/v3/fear-and-greed/latest",{"X-CMC_PRO_API_KEY":key});
    if(r.status!==200){console.log("[cmc] fear-greed HTTP",r.status,r.body.slice(0,150));return null;}
    const d=JSON.parse(r.body).data;const v=Number(d.value),cls=d.value_classification;
    const faCls={"Extreme Fear":"ترس شدید","Fear":"ترس","Neutral":"خنثی","Greed":"طمع","Extreme Greed":"طمع شدید"}[cls]||cls;
    const emoji=v<25?"😨":v<45?"😟":v<55?"😐":v<75?"🙂":"🤑";
    return [`${emoji} شاخص ترس و طمع بازار`,"",
      `شاخص ترس و طمع کریپتو الان روی ${fa(v)} از ۱۰۰ است، یعنی وضعیت «${faCls}».`,
      "این شاخص فقط حال‌وهوای کلی و احساسات بازار را نشان می‌دهد، نه پیش‌بینی قیمت. در ناحیهٔ ترس بازار محتاط است و در ناحیهٔ طمع پرهیجان.",
      "","📌 منبع: CoinMarketCap."].join("\n");
  }catch(e){console.log("[cmc] failed:",e.message);return null;}
}
const RWANAME={USOON:["نفت دیجیتال","Oil"],XAUT:["تترگلد","Gold"],SLVON:["نقره دیجیتال","Silver"],COPXON:["مس دیجیتال","Copper"],PPLTON:["پلاتین دیجیتال","Platinum"],UNGON:["گاز طبیعی دیجیتال","Natural Gas"]};
function cleanEn(en){en=String(en||"").replace(/\s*\(.*?\)\s*/g," ").trim();if(/^[A-Z0-9 .]+$/.test(en)&&en.replace(/[^A-Za-z]/g,"").length>3)en=en.toLowerCase().replace(/\b\w/g,c=>c.toUpperCase());return en;}
async function fetch24hAgoPrices(){
  try{
    const repo=process.env.GITHUB_REPOSITORY||"mjahmadi-wallex/wallex-market-feed";
    const until=new Date(Date.now()-24*3600e3).toISOString();
    const r1=await get(`https://api.github.com/repos/${repo}/commits?path=markets.json&until=${until}&per_page=1`);
    if(r1.status!==200)throw new Error("commits API "+r1.status);
    const commits=JSON.parse(r1.body);if(!commits.length)throw new Error("no commit 24h ago");
    const sha=commits[0].sha, when=commits[0].commit.committer.date;
    const r2=await get(`https://raw.githubusercontent.com/${repo}/${sha}/markets.json`);
    const j=JSON.parse(r2.body);const p={};for(const m of (j.result&&j.result.markets)||[])p[m.symbol]=m.price;
    console.log(`[price] 24h-ago snapshot ${when} (${Object.keys(p).length} prices)`);
    return p;
  }catch(e){console.log("[price] 24h-ago fetch failed, fallback to change_24h:",e.message);return null;}
}
async function pricePosts(){
  let mk;try{mk=JSON.parse(fs.readFileSync(path.join(ROOT,"markets.json"),"utf8"));}catch{console.log("[price] markets.json not found");return[];}
  const M=(mk.result&&mk.result.markets)||[];const by={};for(const m of M)by[m.symbol]=m;
  const num=x=>{if(x===null||x===undefined||x==="")return null;const n=Number(x);return Number.isFinite(n)?n:null;};
  const prev=await fetch24hAgoPrices();const exact=!!prev;
  const dOf=m=>{const now=num(m.price);if(now===null)return null;if(prev){const p=num(prev[m.symbol]);if(p!==null&&p>0)return{d:(now-p)/p*100,now};}const c=num(m.change_24h);return c===null?null:{d:c,now};};
  const nm=m=>{const tk=m.base_asset;if(RWANAME[tk])return `${RWANAME[tk][0]} (${RWANAME[tk][1]})`;return `${m.fa_base_asset||tk} (${cleanEn(m.en_base_asset||tk)})`;};
  const mrk=d=>d>=0?"🟢":"🔴",sw=d=>d>=0?"مثبت":"منفی";
  const winLabel=exact?"نسبت به همین ساعتِ دیروز":"در ۲۴ ساعت گذشته";
  const majors=["BTC","ETH","XRP","SOL","BNB","DOGE","TON","ADA","TRX","AVAX","LINK","LTC"];
  const rwa=["XAUT","SLVON","COPXON","USOON","PPLTON","UNGON"];
  const A=["🪙 رصد قیمت بازار","",`قیمت و تغییر ${winLabel} در والکس:`,"","💠 بزرگان بازار"];
  for(const b of majors){const m=by[b+"USDT"];if(!m)continue;const x=dOf(m);if(!x)continue;A.push(`${mrk(x.d)} ${nm(m)}: ${price(x.now)} دلار، ${sw(x.d)} ${pct(Math.abs(x.d))} درصد`);}
  A.push("","🛢 کالا و RWA");
  for(const b of rwa){const m=by[b+"USDT"];if(!m)continue;const x=dOf(m);if(!x)continue;A.push(`${mrk(x.d)} ${nm(m)}: ${price(x.now)} دلار، ${sw(x.d)} ${pct(Math.abs(x.d))} درصد`);}
  A.push("","📌 قیمت‌ها از بازار دلاری والکس.");
  const rows=[];
  for(const m of M){
    if(m.quote_asset!=="USDT")continue;if((num(m.quote_volume_24h)||0)<50000)continue;
    const x=dOf(m);if(!x)continue;if(Math.abs(x.d)>60)continue;
    const c=num(m.change_24h);
    if(exact&&c!==null&&Math.abs(x.d)>=8&&Math.abs(x.d-c)>Math.abs(x.d)*0.5)continue; // computed delta disagrees strongly with feed -> stale 24h-ago price
    rows.push({m,d:x.d,now:x.now});
  }
  const gain=[...rows].sort((a,b)=>b.d-a.d).slice(0,5), lose=[...rows].sort((a,b)=>a.d-b.d).slice(0,5);
  const B=["📊 بزرگ‌ترین تغییرات ۲۴ ساعته","",`${winLabel}، بر مبنای بازارهای دلاری پرگردش والکس.`,"","📈 بیشترین رشد"];
  for(const r of gain)B.push(`🟢 ${nm(r.m)}: ${price(r.now)} دلار، مثبت ${pct(r.d)} درصد`);
  B.push("","📉 بیشترین افت");
  for(const r of lose)B.push(`🔴 ${nm(r.m)}: ${price(r.now)} دلار، منفی ${pct(Math.abs(r.d))} درصد`);
  B.push("","📌 همهٔ این بازارها در والکس، اسپات و تعهدی، قابل معامله‌اند.");
  return[A.join("\n"),B.join("\n")];
}

function get(url, redirects=0){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const req=https.request(u,{method:"GET",headers:{"User-Agent":"Mozilla/5.0 (compatible; WallexDeskBot/1.0)","Accept":"*/*"},timeout:25000},res=>{
      if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location&&redirects<4){res.resume();return resolve(get(new URL(res.headers.location,url).href,redirects+1));}
      const ch=[];res.on("data",c=>ch.push(c));res.on("end",()=>resolve({status:res.statusCode,body:Buffer.concat(ch).toString("utf8")}));
    });
    req.on("error",reject);req.on("timeout",()=>req.destroy(new Error("timeout")));req.end();
  });
}
function getH(url,extra,redirects=0){
  return new Promise((resolve,reject)=>{const u=new URL(url);const req=https.request(u,{method:"GET",headers:Object.assign({"User-Agent":"WallexDeskBot/1.0","Accept":"application/json"},extra||{}),timeout:25000},res=>{if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location&&redirects<4){res.resume();return resolve(getH(new URL(res.headers.location,url).href,extra,redirects+1));}const ch=[];res.on("data",c=>ch.push(c));res.on("end",()=>resolve({status:res.statusCode,body:Buffer.concat(ch).toString("utf8")}));});req.on("error",reject);req.on("timeout",()=>req.destroy(new Error("timeout")));req.end();});
}
const strip=s=>(s||"").replace(/<!\[CDATA\[|\]\]>/g,"").replace(/<[^>]+>/g," ").replace(/&[a-z#0-9]+;/gi," ").replace(/\s+/g," ").trim();
function tag(b,n){const m=b.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`,"i"));return m?m[1]:"";}
function parseRSS(xml,src){
  const items=[];const blocks=xml.match(/<item[\s\S]*?<\/item>/gi)||xml.match(/<entry[\s\S]*?<\/entry>/gi)||[];
  for(const b of blocks){
    let link=strip(tag(b,"link"));if(!link){const m=b.match(/<link[^>]*href="([^"]+)"/i);if(m)link=m[1];}
    const title=strip(tag(b,"title"));
    const dateStr=strip(tag(b,"pubDate"))||strip(tag(b,"published"))||strip(tag(b,"updated"))||strip(tag(b,"dc:date"))||strip(tag(b,"date"));
    const summary=strip(tag(b,"description")||tag(b,"summary")||tag(b,"content")).slice(0,600);
    const parsed=dateStr?Date.parse(dateStr):NaN;
    if(title&&link)items.push({src:src.id,srcName:src.name,id:link,title,link,summary,ts:isNaN(parsed)?Date.now():parsed,tsKnown:!isNaN(parsed)});
  }
  return items;
}
async function fetchSource(src){
  try{
    if(src.type==="rss"){const r=await get(src.url);if(r.status!==200)return[];return parseRSS(r.body,src);}
    if(src.type==="binance"){
      const r=await get("https://www.binance.com/bapi/composite/v1/public/cms/article/catalog/list/query?catalogId=48&pageNo=1&pageSize=15");
      const j=JSON.parse(r.body);const arts=(((j.data||{}).catalogs||[])[0]||{}).articles||j.data?.articles||[];
      return arts.map(a=>({src:"binance",srcName:"Binance",id:String(a.code||a.id),title:strip(a.title),link:`https://www.binance.com/en/support/announcement/${a.code}`,summary:"",ts:a.releaseDate||Date.now(),tsKnown:!!a.releaseDate}));
    }
    if(src.type==="kucoin"){
      const r=await get("https://www.kucoin.com/_api/cms/articles?category=announcements&lang=en_US&page=1&pageSize=15");
      const j=JSON.parse(r.body);const arts=(j.items||j.data?.items||[]);
      return arts.map(a=>({src:"kucoin",srcName:"KuCoin",id:String(a.id||a.path),title:strip(a.title),link:`https://www.kucoin.com/announcement${a.path||""}`,summary:strip(a.summary||""),ts:a.publish_ts||Date.parse(a.createdAt)||Date.now(),tsKnown:!!(a.publish_ts||a.createdAt)}));
    }
  }catch(e){console.log(`[warn] source ${src.id} failed: ${e.message}`);}
  return[];
}
function loadSeen(){try{return JSON.parse(fs.readFileSync(SEEN,"utf8"));}catch{return{};}}
function saveSeen(s){fs.mkdirSync(path.dirname(SEEN),{recursive:true});fs.writeFileSync(SEEN,JSON.stringify(s));}

// ---- LLM core (OpenAI-compatible, endpoint-tolerant) ----
function llmPost(url,body,key){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const req=https.request(u,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`,"Content-Length":Buffer.byteLength(body)},timeout:120000},
      res=>{const ch=[];res.on("data",c=>ch.push(c));res.on("end",()=>resolve({status:res.statusCode,data:Buffer.concat(ch).toString("utf8")}));});
    req.on("error",reject);req.on("timeout",()=>req.destroy(new Error("llm timeout")));req.write(body);req.end();
  });
}
function llmUrls(){
  let base=(process.env.LLM_BASE_URL||"").replace(/\/+$/,"");const urls=[];
  if(base){if(/\/chat\/completions$/.test(base))urls.push(base);else if(/\/v\d+$/.test(base))urls.push(base+"/chat/completions");else urls.push(base+"/chat/completions",base+"/v1/chat/completions");}
  return [...new Set(urls)];
}
async function llmChat(messages,maxTokens,modelOverride){
  const key=process.env.LLM_API_KEY,model=modelOverride||process.env.LLM_MODEL;
  const urls=llmUrls();if(!urls.length)throw new Error("LLM_BASE_URL empty");
  const mk=noThink=>JSON.stringify(noThink?{model,temperature:0.5,max_tokens:maxTokens,messages,reasoning:{enabled:false}}:{model,temperature:0.5,max_tokens:maxTokens,messages});
  let last="";
  for(const u of urls){
    for(const noThink of [true,false]){
      let r;try{r=await llmPost(u,mk(noThink),key);}catch(e){last="req error: "+e.message;console.log(`[llm] request error (${e.message})`);break;}
      if(r.status===400 && noThink){console.log("[llm] 400 with reasoning param, retrying without it");continue;}
      if(r.status!==200){last=`HTTP ${r.status}: ${r.data.slice(0,150)}`;console.log(`[llm] ${r.status}, next endpoint`);break;}
      let j;try{j=JSON.parse(r.data);}catch{last="not JSON: "+r.data.slice(0,150);break;}
      const ch=(j.choices&&j.choices[0])||{};const content=(ch.message&&(ch.message.content||ch.message.reasoning_content))||"";
      if(!content){console.log(`[llm] EMPTY content; finish=${ch.finish_reason}; raw=${r.data.slice(0,300)}`);last="empty content";break;}
      return content;
    }
  }
  throw new Error(last||"no endpoint worked");
}

const SELECT_SYS = `تو سردبیر دسک بازار والکس هستی. از میان خبرهای زیر، داغ‌ترین و مهم‌ترین‌ها را برای مخاطب ایرانی کریپتو انتخاب و به‌ترتیب اولویت (داغ‌ترین اول) مرتب کن.
معیار داغ‌بودن: اثر بزرگ بر بازار، تصمیم نهاد ناظر، رویداد کلان، هک یا رخداد امنیتی مهم، لیست‌شدن یا محصول مهم. خبر کم‌اهمیت یا تکراری یا صرفا تبلیغاتی را کنار بگذار.
حداکثر ${MAX_POSTS} مورد. اگر تعداد خبرهای واقعا ارزشمند کمتر بود، کمتر انتخاب کن.
خروجی فقط یک آرایه JSON از id‌های انتخابی به‌ترتیب اولویت، بدون هیچ متن اضافه: ["<id>","<id>"]`;

const WRITE_SYS = `تو دسک بازار والکس هستی، صرافی ارز دیجیتال ایرانی، و برای کانال تلگرام تیم یک پست خبری فارسی می‌نویسی.
لحن: حرفه‌ای و مسلط مثل یک تریدر کارکشته که تصویر کل بازار را می‌بیند، ولی ساده و همه‌فهم. جدی و بدون هیجان و بزرگ‌نمایی.
ساختار پست: یک تیتر با یک ایموجی در ابتدا، بعد خبر، بعد چرا مهم است و چه ربطی به بازار و کاربر ایرانی دارد. حداقل ۲۵۰ کلمه بنویس، ولی کل پست باید در یک پیام تلگرام جا شود، پس زیر ۴۰۹۶ کاراکتر و ترجیحا زیر ۳۵۰۰ کاراکتر بماند (حدود ۲۵۰ تا ۵۵۰ کلمه). تکه‌تکه ننویس.
برای رسیدن به طول فقط با زمینه و توضیح عمومی و درست بنویس. هیچ عدد، قیمت، نقل‌قول یا ادعای خاصی که در خبر داده‌نشده نساز. اگر اطلاعات خبر کم است، کوتاه‌تر بنویس ولی چیزی از خودت اضافه نکن.
هرجا اسم ارز آوردی معادل انگلیسی داخل پرانتز بیاور، مثل بیت‌کوین (Bitcoin).
در آوانگاریِ نام‌ها دقت کن و درست و رایج بنویس. مثلا CoinEx می‌شود کوینکس (نه کواین‌اکس)، MarsCoin می‌شود مارسکوین (نه مارکوین)، Binance می‌شود بایننس، Ethereum می‌شود اتریوم. اگر آوانگاری رایج فارسی یک نام را مطمئن نیستی، فقط نام انگلیسی را بیاور.
برای خوانایی بهتر، از ایموجی‌های مرتبط و به‌جا داخل متن هم استفاده کن (به‌اندازه، نه زیاد)، مثلا کنار تیتر و نکته‌های کلیدی.
خط قرمز: قیمت تتر ننویس. سیگنال خرید و فروش و هدف قیمتی و وعده سود ممنوع. نام صرافی رقیب ایرانی نبر. فقط گزارش و تحلیل، نه توصیه معاملاتی.
نگارش: خط تیره بلند ممنوع، ویرگول. بدون تنوین، دقیقا نه دقیقاً. بدون هٔ، نکته نه نکتهٔ. اعداد فارسی. لینک داخل متن نگذار، من خودم منبع را ته پست اضافه می‌کنم.
فقط و فقط متن نهایی پست فارسی را برگردان، بدون توضیح اضافه و بدون JSON.`;

async function selectHot(cands){
  const list=cands.map(c=>`id=${c.id} | ${c.srcName} | ${ago(c.ts)} | ${c.title}`).join("\n");
  const content=await llmChat([{role:"system",content:SELECT_SYS},{role:"user",content:list}],1200);
  const m=content.match(/\[[\s\S]*\]/);if(!m)throw new Error("select: no JSON array in content");
  return JSON.parse(m[0]).map(String);
}
async function writePost(c){
  const u=`منبع: ${c.srcName}\nتیتر: ${c.title}\nخلاصه: ${c.summary||"-"}`;
  let t=await llmChat([{role:"system",content:WRITE_SYS},{role:"user",content:u}],8000,process.env.WRITER_MODEL);
  return t.trim();
}

function tgSend(text){
  const tok=process.env.TELEGRAM_BOT_TOKEN,chat=process.env.TELEGRAM_CHAT_ID;
  const body=JSON.stringify({chat_id:chat,text,disable_web_page_preview:false});
  return new Promise((resolve,reject)=>{
    const req=https.request(`https://api.telegram.org/bot${tok}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},
      r=>{const ch=[];r.on("data",c=>ch.push(c));r.on("end",()=>{const d=Buffer.concat(ch).toString("utf8");let j={};try{j=JSON.parse(d);}catch{} j.ok?resolve():reject(new Error(d));});});
    req.on("error",reject);req.write(body);req.end();
  });
}
async function tgSendLong(full){
  const parts=[];let cur="";
  for(const para of full.split("\n\n")){
    if(cur&&(cur+"\n\n"+para).length>3800){parts.push(cur);cur=para;}else cur=cur?cur+"\n\n"+para:para;
  }
  if(cur)parts.push(cur);
  const safe=[];for(const p of parts){if(p.length<=4096)safe.push(p);else for(let i=0;i<p.length;i+=4000)safe.push(p.slice(i,i+4000));}
  for(let i=0;i<safe.length;i++){await tgSend(safe[i]);await sleep(1500);}
}

(async()=>{
  const seen=loadSeen();const ignoreSeen=process.env.IGNORE_SEEN==="1";
  // ---- price-watch posts (every run), template-based from Wallex markets.json ----
  const pp=await pricePosts(); console.log(`price posts: ${pp.length}`);
  for(const p of pp){ console.log("\n----- PRICE POST -----\n"+p.slice(0,300)); if(!DRY){ try{await tgSend(p);await sleep(1500);console.log("[price sent]");}catch(e){console.log("[price send failed]",e.message);} } }
  const gp=await globalPost();
  if(gp){ console.log("\n----- GLOBAL POST -----\n"+gp.slice(0,400)); if(!DRY){ try{await tgSend(gp);await sleep(1500);console.log("[global sent]");}catch(e){console.log("[global send failed]",e.message);} } }
  const fg=await fearGreedPost();
  if(fg){ console.log("\n----- FEAR&GREED -----\n"+fg); if(!DRY){ try{await tgSend(fg);await sleep(1500);console.log("[cmc sent]");}catch(e){console.log("[cmc send failed]",e.message);} } }
  const wp=await whalePost();
  if(wp){ console.log("\n----- WHALE POST -----\n"+wp.slice(0,300)); if(!DRY){ try{await tgSend(wp);await sleep(1500);console.log("[whale sent]");}catch(e){console.log("[whale send failed]",e.message);} } }
  const hacks=await defiLlamaHacks(seen,ignoreSeen); console.log(`hack posts: ${hacks.length}`);
  for(const p of hacks){ console.log("\n----- HACK POST -----\n"+p); if(!DRY){ try{await tgSend(p);await sleep(1500);console.log("[hack sent]");}catch(e){console.log("[hack send failed]",e.message);} } }

  let all=[];for(const s of SOURCES)all=all.concat(await fetchSource(s));
  console.log(`fetched ${all.length} items total`);
  const cutoff=Date.now()-(+(process.env.MAX_AGE_H||48))*3600e3;
  const fresh=all.filter(it=>(ignoreSeen||!(seen[it.src]||[]).includes(String(it.id)))&&it.ts>=cutoff).sort((a,b)=>b.ts-a.ts);
  const cnt={},cands=[];
  for(const it of fresh){if((cnt[it.src]||0)>=PER_SOURCE)continue;cnt[it.src]=(cnt[it.src]||0)+1;cands.push(it);if(cands.length>=MAX_CANDIDATES)break;}
  console.log(`new(recent): ${fresh.length}, candidates: ${cands.length}`);

  let order=null;
  if(cands.length){ try{order=await selectHot(cands);}catch(e){console.log("[error] select:",e.message);order=null;} }
  if(order===null){ order=cands.slice(0,MAX_POSTS).map(c=>String(c.id)); console.log(`[select] LLM failed, fallback to recency: ${order.length}`); }
  else { console.log(`selected ${order.length} (priority order)`); }
  const byId=Object.fromEntries(cands.map(c=>[String(c.id),c]));
  const chosen=order.map(id=>byId[String(id)]).filter(Boolean).slice(0,MAX_POSTS);

  let sent=0;
  for(const c of chosen){
    let text;try{text=await writePost(c);}catch(e){console.log("[error] write:",e.message);continue;}
    if(!text){continue;}
    let footer=`\n\n🔗 منبع (${c.srcName}): ${c.link}`;
    if(c.tsKnown) footer+= `\n🕒 انتشار در منبع: ${tehranStamp(c.ts)} به وقت تهران، حدود ${ago(c.ts)}`;
    let bodyText=text; const budget=4096-footer.length-1;
    if(bodyText.length>budget){ const cut=bodyText.slice(0,budget); const b=Math.max(cut.lastIndexOf("\n"),cut.lastIndexOf(". "),cut.lastIndexOf("، "),cut.lastIndexOf(" ")); bodyText=cut.slice(0, b>200?b:budget).trim()+"…"; }
    const full=bodyText+footer;
    console.log(`\n----- POST (${c.srcName}, ${text.split(/\s+/).length} words, ${full.length} chars) -----\n${full.slice(0,400)}...`);
    if(!DRY){ try{await tgSend(full);sent++;console.log("[sent]");await sleep(1500);}catch(e){console.log("[send failed]",e.message);} }
  }
  console.log(`\nposted ${sent} of ${chosen.length} chosen`);

  for(const it of all){(seen[it.src]||=[]);if(!seen[it.src].includes(String(it.id)))seen[it.src].unshift(String(it.id));seen[it.src]=seen[it.src].slice(0,200);}
  if(!DRY&&!ignoreSeen)saveSeen(seen);
  console.log("done"+(DRY?" (dry)":ignoreSeen?" (ignore-seen, not saved)":""));
})();
