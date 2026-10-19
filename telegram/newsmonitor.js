#!/usr/bin/env node
/* Wallex Desk — news + market bot. Node, zero deps. Runs TWICE daily: 11:00 and 17:00 Tehran.
 * Each slot: up to 2 short news posts + 1 whale post + 1 pump/dump post + 1 market-analysis post.
 * Morning slot (11:00) also sends the once-daily Wallex profit/loss report. Posts are short (<=2 paragraphs).
 * Env: LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, WRITER_MODEL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *      SLOT(morning|evening; else auto by Tehran hour) MAX_POSTS(=2) MAX_CANDIDATES(=40)
 *      PER_SOURCE(=10) MAX_AGE_H(=48) PUMP_THRESHOLD(=12) CMC_API_KEY IGNORE_SEEN DRY */
const fs = require("fs"), path = require("path"), https = require("https");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const SEEN = path.join(ROOT, "telegram", "state", "seen.json");
const MAX_POSTS = +(process.env.MAX_POSTS || 2);
const MAX_CANDIDATES = +(process.env.MAX_CANDIDATES || 40);
const PER_SOURCE = +(process.env.PER_SOURCE || 10);
const DRY = process.env.DRY === "1";

const SOURCES = [
  { id: "cointelegraph",   name: "Cointelegraph",    type: "rss", url: "https://cointelegraph.com/rss" },
  { id: "coindesk",        name: "CoinDesk",         type: "rss", url: "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml" },
  { id: "cryptonews",      name: "CryptoNews",       type: "rss", url: "https://cryptonews.com/feed/" },
  { id: "cryptonews_io",   name: "crypto.news",      type: "rss", url: "https://crypto.news/feed/" },
  { id: "bitcoinmagazine", name: "Bitcoin Magazine", type: "rss", url: "https://bitcoinmagazine.com/feed" },
  { id: "bitcoincom",      name: "Bitcoin.com News", type: "rss", url: "https://news.bitcoin.com/feed/" },
  { id: "decrypt",         name: "Decrypt",          type: "rss", url: "https://decrypt.co/feed" },
  { id: "beincrypto",      name: "BeInCrypto",       type: "rss", url: "https://beincrypto.com/feed/" },
  { id: "cryptopotato",    name: "CryptoPotato",     type: "rss", url: "https://cryptopotato.com/feed/" },
  { id: "binance",         name: "Binance",          type: "binance" },
  { id: "kucoin",          name: "KuCoin",           type: "kucoin" },
];

const FA = "۰۱۲۳۴۵۶۷۸۹";
const fa = s => String(s).replace(/[0-9]/g, d => FA[d]);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function stripMd(t){return String(t)
  .replace(/\*\*(.*?)\*\*/g,"$1")
  .replace(/__(.*?)__/g,"$1")
  .replace(/(^|\n)\s{0,3}#{1,6}\s*/g,"$1")
  .replace(/\*(.*?)\*/g,"$1")
  .replace(/`{1,3}/g,"")
  .replace(/[　-〿぀-ヿㇰ-ㇿ㈀-㋿㐀-䶿一-鿿豈-﫿＀-￯가-힯]+/g,"")
  .replace(/[ \t]{2,}/g," ")
  .replace(/[ \t]+([،,.؛:!؟)])/g,"$1")
  .replace(/\n{3,}/g,"\n\n").trim();}
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
const STABLENAME={USDT:"تتر",DAI:"دای"};
async function stablecoinPost(){
  try{
    const r=await get("https://stablecoins.llama.fi/stablecoins?includePrices=false");
    if(r.status!==200){console.log("[stable] HTTP",r.status);return null;}
    const arr=(JSON.parse(r.body).peggedAssets)||[];
    if(!arr.length){console.log("[stable] empty");return null;}
    const val=o=>{if(!o)return 0;const v=(o.peggedUSD!=null?o.peggedUSD:Object.values(o)[0]);return Number(v)||0;};
    let now=0,d1=0,d7=0;
    for(const a of arr){now+=val(a.circulating);d1+=val(a.circulatingPrevDay);d7+=val(a.circulatingPrevWeek);}
    if(!(now>0)){console.log("[stable] zero total");return null;}
    const flow24=now-d1, flow7=now-d7;
    const mrk=n=>n>=0?"🟢":"🔴", sgn=n=>n>=0?"مثبت":"منفی";
    const flowFmt=n=>{const a=Math.abs(n);let s;if(a>=1e9)s=`${fa((a/1e9).toFixed(2)).replace(".","٫")} میلیارد دلار`;else if(a>=1e6)s=`${fa((a/1e6).toFixed(0))} میلیون دلار`;else s=`${fa(Math.round(a/1e3))} هزار دلار`;return `${sgn(n)} ${s}`;};
    const nm=sym=>{const P=STABLENAME[String(sym).toUpperCase()];return P?`${P} (${sym})`:sym;};
    const rows=arr.map(a=>({sym:String(a.symbol||""),now:val(a.circulating),d1:val(a.circulatingPrevDay)})).filter(x=>x.now>0).sort((x,y)=>y.now-x.now).slice(0,5);
    const L=["💵 جریان استیبل‌کوین‌ها","",
      `کل عرضهٔ استیبل‌کوین‌ها الان حدود ${capFmt(now)} است.`,
      `${mrk(flow24)} تغییر ۲۴ ساعته: ${flowFmt(flow24)}`,
      `${mrk(flow7)} تغییر ۷ روزه: ${flowFmt(flow7)}`,
      "","🏦 بزرگ‌ترین استیبل‌کوین‌ها و تغییر ۲۴ ساعته"];
    for(const x of rows){const f=x.now-x.d1;L.push(`${mrk(f)} ${nm(x.sym)}: ${capFmt(x.now)}، ${flowFmt(f)}`);}
    L.push("",
      "رشد عرضهٔ استیبل‌کوین‌ها یعنی ورود پول تازه و نقدینگی آمادهٔ خرید در بازار، و افت آن یعنی خروج نقدینگی. این فقط نمای کلان جریان پول است، نه سیگنال خرید و فروش.",
      "","📌 منبع: DefiLlama.");
    return L.join("\n");
  }catch(e){console.log("[stable] failed:",e.message);return null;}
}
const RWANAME={USOON:["نفت دیجیتال","Oil"],XAUT:["تترگلد","Gold"],SLVON:["نقره دیجیتال","Silver"],COPXON:["مس دیجیتال","Copper"],PPLTON:["پلاتین دیجیتال","Platinum"],UNGON:["گاز طبیعی دیجیتال","Natural Gas"]};
function cleanEn(en){en=String(en||"").replace(/\s*\(.*?\)\s*/g," ").trim();if(/^[A-Z0-9 .]+$/.test(en)&&en.replace(/[^A-Za-z]/g,"").length>3)en=en.toLowerCase().replace(/\b\w/g,c=>c.toUpperCase());return en;}
async function fetchAgoPrices(hoursAgo){
  try{
    const repo=process.env.GITHUB_REPOSITORY||"mjahmadi-wallex/wallex-market-feed";
    const until=new Date(Date.now()-hoursAgo*3600e3).toISOString();
    const r1=await get(`https://api.github.com/repos/${repo}/commits?path=markets.json&until=${until}&per_page=1`);
    if(r1.status!==200)throw new Error("commits API "+r1.status);
    const commits=JSON.parse(r1.body);if(!commits.length)throw new Error(`no commit ${hoursAgo}h ago`);
    const sha=commits[0].sha, when=commits[0].commit.committer.date;
    const r2=await get(`https://raw.githubusercontent.com/${repo}/${sha}/markets.json`);
    const j=JSON.parse(r2.body);const p={};for(const m of (j.result&&j.result.markets)||[])p[m.symbol]=m.price;
    console.log(`[price] ${hoursAgo}h-ago snapshot ${when} (${Object.keys(p).length} prices)`);
    return p;
  }catch(e){console.log(`[price] ${hoursAgo}h-ago fetch failed:`,e.message);return null;}
}
// Per-coin USD move using the LIQUID Wallex TMN markets, normalized by USDT/TMN (removes rial drift).
// prev = snapshot price map (symbol->price) for the window start. Returns [{base,fa,en,usdNow,move,volUsd}].
function wallexUsdMovers(M, prev, minUsdVol, noFallback){
  const num=x=>{if(x===null||x===undefined||x==="")return null;const n=Number(x);return Number.isFinite(n)?n:null;};
  const bySym={};for(const m of M)bySym[m.symbol]=m;
  const usdtNow=num((bySym["USDTTMN"]||{}).price);
  const usdtPrev=prev?num(prev["USDTTMN"]):null;
  if(!usdtNow)return [];
  const out=[];
  for(const m of M){
    if(m.quote_asset!=="TMN"||m.base_asset==="USDT")continue;
    const volUsd=(num(m.quote_volume_24h)||0)/usdtNow;
    if(volUsd<minUsdVol)continue;
    const nowTmn=num(m.price);if(nowTmn===null)continue;
    const usdNow=nowTmn/usdtNow;
    let move=null;
    if(prev&&usdtPrev){const pTmn=num(prev[m.symbol]);if(pTmn!==null&&pTmn>0){const usdPrev=pTmn/usdtPrev;if(usdPrev>0)move=(usdNow-usdPrev)/usdPrev*100;}}
    if(move===null){ if(noFallback)continue; const c=num(m.change_24h); if(c===null)continue; move=c; }
    if(Math.abs(move)>80)continue;
    const R=RWANAME[m.base_asset];
    out.push({base:m.base_asset,fa:R?R[0]:m.fa_base_asset,en:R?R[1]:cleanEn(m.en_base_asset||m.base_asset),usdNow,move,volUsd});
  }
  return out;
}
async function pricePosts(){
  let mk;try{mk=JSON.parse(fs.readFileSync(path.join(ROOT,"markets.json"),"utf8"));}catch{console.log("[price] markets.json not found");return[];}
  const M=(mk.result&&mk.result.markets)||[];const by={};for(const m of M)by[m.symbol]=m;
  const num=x=>{if(x===null||x===undefined||x==="")return null;const n=Number(x);return Number.isFinite(n)?n:null;};
  const prev=await fetchAgoPrices(24);const exact=!!prev;
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
  const mv=wallexUsdMovers(M, prev, +(process.env.MOVERS_MIN_VOL||10000));
  const nmv=it=>`${it.fa||it.base} (${it.en})`;
  const gain=[...mv].sort((a,b)=>b.move-a.move).slice(0,5), lose=[...mv].sort((a,b)=>a.move-b.move).slice(0,5);
  const B=["📊 پرسودترین و پرضررترین کوین‌های والکس","",`${winLabel}، بر مبنای بازارهای پرگردش والکس (قیمت دلاری).`,"","📈 بیشترین رشد"];
  for(const r of gain)B.push(`🟢 ${nmv(r)}: ${price(r.usdNow)} دلار، مثبت ${pct(r.move)} درصد`);
  B.push("","📉 بیشترین افت");
  for(const r of lose)B.push(`🔴 ${nmv(r)}: ${price(r.usdNow)} دلار، منفی ${pct(Math.abs(r.move))} درصد`);
  B.push("","📌 همهٔ این بازارها در والکس، اسپات و تعهدی، قابل معامله‌اند.");
  return[A.join("\n"),B.join("\n")];
}
async function pumpDumpPost(windowH){
  let mk;try{mk=JSON.parse(fs.readFileSync(path.join(ROOT,"markets.json"),"utf8"));}catch{console.log("[pump] markets.json not found");return null;}
  const M=(mk.result&&mk.result.markets)||[];
  const winH=windowH||+(process.env.PUMP_WINDOW_H||12), thr=+(process.env.PUMP_THRESHOLD||12);
  const prev=await fetchAgoPrices(winH);
  if(!prev){console.log("[pump] no window snapshot, skip");return null;}
  const mv=wallexUsdMovers(M, prev, +(process.env.PUMP_MIN_VOL||20000), true).filter(it=>Math.abs(it.move)>=thr);
  if(!mv.length){console.log("[pump] no abnormal moves");return null;}
  mv.sort((a,b)=>Math.abs(b.move)-Math.abs(a.move));
  const nmv=it=>`${it.fa||it.base} (${it.en})`;
  const L=["🚨 هشدار حرکت ناگهانی بازار","",`دو کوینی که در حدود ${fa(winH)} ساعت گذشته بیشترین جهش یا ریزش را در والکس داشته‌اند:`,""];
  for(const r of mv.slice(0,2)){const up=r.move>=0;L.push(`${up?"🟢📈":"🔴📉"} ${nmv(r)}: ${price(r.usdNow)} دلار، ${up?"جهش":"ریزش"} ${pct(Math.abs(r.move))} درصد`);}
  L.push("","⚠️ حرکت‌های تند اغلب پرریسک و زودگذرند و گاهی پامپ‌ودامپ‌اند. فقط رصد است، نه سیگنال خرید و فروش.");
  return L.join("\n");
}
const ANALYSIS_SYS = `تو تحلیل‌گر دسک بازار والکس هستی و یک «جمع‌بندی روزانهٔ بازار» فارسی برای کانال تلگرام تیم می‌نویسی.
فقط بر مبنای همان داده‌هایی که در ادامه می‌دهم (نه چیز دیگر) یک تحلیل خیلی کوتاه و کاربردی بنویس: وضعیت کلی بازار، نقدینگی و احساسات، و مهم‌ترین نکته‌ای که ارزش رصد دارد.
ساختار: یک تیتر با ایموجی، بعد نهایتاً دو پاراگراف کوتاه. کل پست زیر ۷۰۰ کاراکتر بماند. طولانی ننویس.
لحن: حرفه‌ای و مسلط ولی ساده و همه‌فهم، بدون هیجان و بزرگ‌نمایی.
هرجا اسم ارز آوردی معادل انگلیسی داخل پرانتز بیاور مثل بیت‌کوین (Bitcoin). اعداد فارسی.
خط قرمز: قیمت تتر ننویس. سیگنال خرید و فروش و هدف قیمتی و وعدهٔ سود ممنوع. نام صرافی رقیب ایرانی نبر. فقط تحلیل و رصد، نه توصیهٔ معاملاتی.
نگارش: خط تیرهٔ بلند ممنوع، به‌جایش ویرگول. بدون تنوین. بدون هٔ. هیچ مارک‌داونی (نه ** و نه * و نه # و نه بک‌تیک) نگذار. فقط حروف فارسی و در صورت نیاز انگلیسی؛ هیچ حرف چینی یا ژاپنی یا کره‌ای یا خط دیگری نیاور.
فقط متن نهایی پست را برگردان، بدون توضیح اضافه.`;
async function marketAnalysisPost(){
  try{
    const lines=[];
    try{ const g=JSON.parse((await get("https://api.coingecko.com/api/v3/global")).body).data;
      lines.push(`ارزش کل بازار: ${capFmt(g.total_market_cap.usd)}، تغییر ۲۴ساعته ${g.market_cap_change_percentage_24h_usd>=0?"+":"-"}${Math.abs(g.market_cap_change_percentage_24h_usd).toFixed(1)} درصد`);
      lines.push(`دامیننس: بیت‌کوین ${g.market_cap_percentage.btc.toFixed(1)} درصد، اتریوم ${g.market_cap_percentage.eth.toFixed(1)} درصد`);
    }catch(e){console.log("[analysis] global failed",e.message);}
    const cmc=process.env.CMC_API_KEY;
    if(cmc){ try{ const r=await getH("https://pro-api.coinmarketcap.com/v3/fear-and-greed/latest",{"X-CMC_PRO_API_KEY":cmc}); if(r.status===200){const d=JSON.parse(r.body).data;lines.push(`شاخص ترس و طمع: ${d.value} از ۱۰۰ (${d.value_classification})`);} }catch(e){} }
    try{ const r=await get("https://stablecoins.llama.fi/stablecoins?includePrices=false"); const arr=(JSON.parse(r.body).peggedAssets)||[]; const val=o=>{if(!o)return 0;const v=(o.peggedUSD!=null?o.peggedUSD:Object.values(o)[0]);return Number(v)||0;}; let now=0,d1=0;for(const a of arr){now+=val(a.circulating);d1+=val(a.circulatingPrevDay);} lines.push(`کل عرضهٔ استیبل‌کوین‌ها: ${Math.round(now/1e9)} میلیارد دلار، تغییر ۲۴ساعته ${(now-d1)>=0?"+":"-"}${Math.round(Math.abs(now-d1)/1e6)} میلیون دلار (ورود یا خروج نقدینگی)`); }catch(e){console.log("[analysis] stable failed",e.message);}
    try{
      const mk=JSON.parse(fs.readFileSync(path.join(ROOT,"markets.json"),"utf8"));const M=(mk.result&&mk.result.markets)||[];
      const prev=await fetchAgoPrices(24);
      const mv=wallexUsdMovers(M, prev, 10000).sort((a,b)=>b.move-a.move);
      const fmtm=r=>`${r.en} ${r.move>=0?"+":"-"}${Math.abs(r.move).toFixed(1)} درصد`;
      const gg=mv.slice(0,3).map(fmtm).join("، ");
      const ll=mv.slice(-3).reverse().map(fmtm).join("، ");
      if(gg)lines.push(`بیشترین رشد ۲۴ساعتهٔ والکس: ${gg}`);
      if(ll)lines.push(`بیشترین افت ۲۴ساعتهٔ والکس: ${ll}`);
    }catch(e){console.log("[analysis] movers failed",e.message);}
    if(lines.length<2){console.log("[analysis] not enough data");return null;}
    const data="داده‌های امروز بازار:\n"+lines.join("\n");
    const writer=process.env.WRITER_MODEL, fb=process.env.LLM_MODEL;
    let t;
    try{ t=await llmChat([{role:"system",content:ANALYSIS_SYS},{role:"user",content:data}],4000,writer); }
    catch(e){ if(writer&&fb&&writer!==fb){console.log(`[analysis] writer failed (${e.message}); fallback to LLM_MODEL`);t=await llmChat([{role:"system",content:ANALYSIS_SYS},{role:"user",content:data}],4000,fb);} else throw e; }
    return stripMd(t);
  }catch(e){console.log("[analysis] failed:",e.message);return null;}
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
معیار داغ‌بودن: اثر بزرگ بر بازار، تصمیم نهاد ناظر، رویداد کلان، هک یا رخداد امنیتی مهم، لیست‌شدن یا محصول مهم.
به این موضوع‌ها وزن و اولویت بیشتری بده: خبرهای مربوط به بیت‌کوین (BTC)، اتریوم (ETH) و سولانا (SOL)؛ خبرهای نفت و طلا و کالاها؛ و جابه‌جایی‌ها و فعالیت‌های بزرگ نهنگ‌ها و دارندگان عمده (whale). اگر چنین خبرهایی در فهرست بود، آن‌ها را بالاتر بیاور.
خبر کم‌اهمیت یا تکراری یا صرفا تبلیغاتی را کنار بگذار.
حداکثر ${MAX_POSTS} مورد. اگر تعداد خبرهای واقعا ارزشمند کمتر بود، کمتر انتخاب کن.
خروجی فقط یک آرایه JSON از id‌های انتخابی به‌ترتیب اولویت، بدون هیچ متن اضافه: ["<id>","<id>"]`;

const WRITE_SYS = `تو دسک بازار والکس هستی، صرافی ارز دیجیتال ایرانی، و برای کانال تلگرام تیم یک پست خبری کوتاه فارسی می‌نویسی.
لحن: حرفه‌ای و مسلط ولی ساده و همه‌فهم. جدی و بدون هیجان و بزرگ‌نمایی.
خیلی خلاصه بنویس: یک تیتر کوتاه با یک ایموجی در ابتدا، بعد نهایتاً دو پاراگراف کوتاه. پاراگراف اول خود خبر در یکی‌دو جمله، پاراگراف دوم اینکه چرا مهم است و چه ربطی به بازار و کاربر ایرانی دارد. کل پست زیر ۶۰۰ کاراکتر بماند. طولانی و چندپاراگرافی ننویس.
هیچ عدد، قیمت، نقل‌قول یا ادعایی که در خبر داده‌نشده نساز. اگر اطلاعات کم است کوتاه‌تر بنویس و چیزی از خودت اضافه نکن.
هرجا اسم ارز آوردی معادل انگلیسی داخل پرانتز بیاور، مثل بیت‌کوین (Bitcoin).
در آوانگاری نام‌ها دقت کن: CoinEx می‌شود کوینکس، MarsCoin می‌شود مارسکوین، Binance بایننس، Ethereum اتریوم. اگر مطمئن نیستی فقط نام انگلیسی را بیاور.
خط قرمز: قیمت تتر ننویس. سیگنال خرید و فروش و هدف قیمتی و وعدهٔ سود ممنوع. نام صرافی رقیب ایرانی نبر. فقط گزارش، نه توصیهٔ معاملاتی.
نگارش: خط تیرهٔ بلند ممنوع، ویرگول. بدون تنوین، دقیقا نه دقیقاً. بدون هٔ. اعداد فارسی. لینک داخل متن نگذار، منبع را خودم ته پست می‌گذارم.
هیچ مارک‌داونی (نه ** و نه * و نه # و نه بک‌تیک) نگذار. فقط حروف فارسی و در صورت نیاز انگلیسی؛ هیچ حرف چینی یا ژاپنی یا کره‌ای یا خط دیگری به‌کار نبر.
فقط متن نهایی پست فارسی را برگردان، بدون توضیح اضافه و بدون JSON.`;

async function selectHot(cands){
  const list=cands.map(c=>`id=${c.id} | ${c.srcName} | ${ago(c.ts)} | ${c.title}`).join("\n");
  const content=await llmChat([{role:"system",content:SELECT_SYS},{role:"user",content:list}],1200);
  const m=content.match(/\[[\s\S]*\]/);if(!m)throw new Error("select: no JSON array in content");
  return JSON.parse(m[0]).map(String);
}
async function writePost(c){
  const u=`منبع: ${c.srcName}\nتیتر: ${c.title}\nخلاصه: ${c.summary||"-"}`;
  const msgs=[{role:"system",content:WRITE_SYS},{role:"user",content:u}];
  const writer=process.env.WRITER_MODEL, fb=process.env.LLM_MODEL;
  let t;
  try{ t=await llmChat(msgs,1500,writer); }
  catch(e){
    if(writer&&fb&&writer!==fb){ console.log(`[write] writer model failed (${e.message}); falling back to LLM_MODEL`); t=await llmChat(msgs,1500,fb); }
    else throw e;
  }
  return stripMd(t);
}
const WHALE_SYS = `تو دسک بازار والکس هستی و یک پست کوتاه فارسی دربارهٔ «فعالیت نهنگ‌ها» برای کانال تلگرام تیم می‌نویسی.
بر مبنای همین یکی‌دو خبری که می‌دهم، خیلی خلاصه بنویس: نهنگ‌ها و دارندگان بزرگ چه کرده‌اند و چرا مهم است.
ساختار: یک تیتر با ایموجی 🐋 در ابتدا، بعد نهایتاً دو پاراگراف کوتاه. کل پست زیر ۶۰۰ کاراکتر.
هیچ عدد یا رقمی که در خبر نیست نساز. هرجا اسم ارز آوردی معادل انگلیسی داخل پرانتز بیاور.
خط قرمز: قیمت تتر ننویس. سیگنال خرید و فروش و هدف قیمتی ممنوع. نام صرافی رقیب ایرانی نبر. فقط رصد و گزارش.
نگارش: خط تیرهٔ بلند ممنوع، ویرگول. بدون تنوین و بدون هٔ. اعداد فارسی. هیچ مارک‌داونی نگذار. فقط فارسی و در صورت نیاز انگلیسی؛ هیچ حرف چینی یا ژاپنی یا کره‌ای نیاور.
فقط متن نهایی پست را برگردان.`;
const WHALE_RE=/\bwhales?\b|large holder|big holder|mega[- ]?whale|whale wallet|whale address|accumulat|dormant (?:wallet|address|whale)|large transfer|moved \$?\d+\s*(?:m|b|million|billion)|transferred \$?\d+\s*(?:m|b|million|billion)/i;
async function whaleNewsPost(cands, usedIds){
  const picks=cands.filter(c=>WHALE_RE.test(`${c.title||""} ${c.summary||""}`)).slice(0,2);
  if(!picks.length){console.log("[whale] no whale-related news");return null;}
  const data=picks.map((c,i)=>`خبر ${i+1} (${c.srcName}):\nتیتر: ${c.title}\nخلاصه: ${c.summary||"-"}`).join("\n\n");
  const writer=process.env.WRITER_MODEL, fb=process.env.LLM_MODEL;
  let t;
  try{ t=await llmChat([{role:"system",content:WHALE_SYS},{role:"user",content:data}],1500,writer); }
  catch(e){ if(writer&&fb&&writer!==fb){console.log(`[whale] writer failed (${e.message}); fallback`);try{t=await llmChat([{role:"system",content:WHALE_SYS},{role:"user",content:data}],1500,fb);}catch(e2){console.log("[whale] failed",e2.message);return null;}} else {console.log("[whale] failed",e.message);return null;} }
  for(const c of picks)usedIds.add(String(c.id));
  return stripMd(t);
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

async function send(label,text){ if(!text)return false; console.log(`\n----- ${label} -----\n`+String(text).slice(0,400)); if(DRY)return true; try{await tgSend(text);await sleep(1500);console.log(`[${label} sent]`);return true;}catch(e){console.log(`[${label} send failed]`,e.message);return false;} }
function tehranYmd(ms){const t=new Date(ms+(3*60+30)*60000);const[jy,jm,jd]=g2j(t.getUTCFullYear(),t.getUTCMonth()+1,t.getUTCDate());return `${jy}-${jm}-${jd}`;}

(async()=>{
  const seen=loadSeen();const ignoreSeen=process.env.IGNORE_SEEN==="1";
  const thHour=new Date(Date.now()+(3*60+30)*60000).getUTCHours();
  const morning=process.env.SLOT?process.env.SLOT.toLowerCase()==="morning":thHour<14;
  console.log(`slot=${morning?"morning(11:00)":"evening(17:00)"} tehranHour=${thHour}`);

  // fetch news candidates once (shared by whale + general news)
  let all=[];for(const s of SOURCES)all=all.concat(await fetchSource(s));
  console.log(`fetched ${all.length} items total`);
  const cutoff=Date.now()-(+(process.env.MAX_AGE_H||48))*3600e3;
  const fresh=all.filter(it=>(ignoreSeen||!(seen[it.src]||[]).includes(String(it.id)))&&it.ts>=cutoff).sort((a,b)=>b.ts-a.ts);
  const cnt={},cands=[];
  for(const it of fresh){if((cnt[it.src]||0)>=PER_SOURCE)continue;cnt[it.src]=(cnt[it.src]||0)+1;cands.push(it);if(cands.length>=MAX_CANDIDATES)break;}
  console.log(`new(recent): ${fresh.length}, candidates: ${cands.length}`);
  const usedIds=new Set();

  // 🐋 whale: up to 2 whale-related news in one short post
  await send("WHALE", await whaleNewsPost(cands, usedIds));

  // 📰 news: up to 2 short separate posts (excluding whale picks)
  const newsCands=cands.filter(c=>!usedIds.has(String(c.id)));
  let order=null;
  if(newsCands.length){ try{order=await selectHot(newsCands);}catch(e){console.log("[error] select:",e.message);order=null;} }
  if(order===null){ order=newsCands.slice(0,MAX_POSTS).map(c=>String(c.id)); console.log(`[select] fallback to recency`); }
  const byId=Object.fromEntries(newsCands.map(c=>[String(c.id),c]));
  const chosen=order.map(id=>byId[String(id)]).filter(Boolean).slice(0,MAX_POSTS);
  let newsSent=0;
  for(const c of chosen){
    let text;try{text=await writePost(c);}catch(e){console.log("[error] write:",e.message);continue;}
    if(!text){continue;}
    let footer=`\n\n🔗 منبع (${c.srcName}): ${c.link}`;
    if(c.tsKnown) footer+= `\n🕒 انتشار در منبع: ${tehranStamp(c.ts)} به وقت تهران، حدود ${ago(c.ts)}`;
    let body=text; const budget=4096-footer.length-1;
    if(body.length>budget){ const cut=body.slice(0,budget); const b=Math.max(cut.lastIndexOf("\n"),cut.lastIndexOf(". "),cut.lastIndexOf("، "),cut.lastIndexOf(" ")); body=cut.slice(0, b>200?b:budget).trim()+"…"; }
    if(await send("NEWS", body+footer)) newsSent++;
    usedIds.add(String(c.id));
  }
  console.log(`news posted ${newsSent} of ${chosen.length}`);

  // 🚨 pump/dump: one short post, up to 2 moves (window = time since last slot)
  await send("PUMP/DUMP", await pumpDumpPost(morning?18:6));

  // 🧭 market analysis (folds global + stablecoin + fear&greed data)
  await send("MARKET ANALYSIS", await marketAnalysisPost());

  // 📊 morning only: once-daily Wallex profit/loss (24h)
  if(morning){
    const stateF=path.join(ROOT,"telegram","state","daily.json");
    const today=tehranYmd(Date.now());
    let st={};try{st=JSON.parse(fs.readFileSync(stateF,"utf8"));}catch{}
    if(ignoreSeen || st.lastProfitLoss!==today){
      const pp=await pricePosts();
      if(pp[1]) await send("PROFIT/LOSS", pp[1]);
      if(!DRY && !ignoreSeen){ try{fs.mkdirSync(path.dirname(stateF),{recursive:true});fs.writeFileSync(stateF,JSON.stringify({lastProfitLoss:today,ts:Date.now()}));}catch(e){console.log("[daily] state save failed",e.message);} }
    } else console.log(`[profit/loss] already sent today (${today}), skip`);
  }

  // health alert if news totally failed
  if(chosen.length>0 && newsSent===0 && !DRY){
    try{ await tgSend("⚠️ هشدار سیستم دسک والکس\n\nاین اجرا هیچ خبری با هوش مصنوعی نوشته و ارسال نشد. احتمالاً کلید یا مدل LLM مشکل دارد."); }catch(e){ console.log("[alert send failed]",e.message); }
  }

  // update seen-state
  for(const it of all){(seen[it.src]||=[]);if(!seen[it.src].includes(String(it.id)))seen[it.src].unshift(String(it.id));seen[it.src]=seen[it.src].slice(0,200);}
  if(!DRY&&!ignoreSeen)saveSeen(seen);
  console.log("done"+(DRY?" (dry)":ignoreSeen?" (ignore-seen)":""));
})();
