#!/usr/bin/env node
/* Wallex Desk — template post generator (no LLM), Node, zero deps.
 * Reads markets.json + telegram/state/snapshot.json, computes inter-run deltas,
 * picks a category, fills Persian templates, writes outbox + new snapshot,
 * and (if TELEGRAM_* env set) sends to Telegram. */
const fs = require("fs"), path = require("path"), https = require("https");

const ROOT = path.resolve(__dirname, "..");
const MARKETS = process.env.MARKETS_FILE || path.join(ROOT, "markets.json");
const SNAP = process.env.SNAP_FILE || path.join(ROOT, "telegram", "state", "snapshot.json");
const OUTBOX = path.join(ROOT, "telegram", "archive");
const VOL_MIN = 20000;

const FA = "۰۱۲۳۴۵۶۷۸۹";
const fa = s => String(s).replace(/[0-9]/g, d => FA[d]);
const toF = x => { if (x === null || x === undefined || x === "") return null; const n = Number(x); return Number.isFinite(n) ? n : null; };
const pct = (v, dec = 1) => fa(Math.abs(v).toFixed(dec)).replace(".", "٫");
function price(p) {
  const ap = Math.abs(p); let s;
  if (ap >= 1000) s = Math.round(p).toLocaleString("en-US");
  else if (ap >= 1) s = p.toFixed(2);
  else if (ap >= 0.01) s = p.toFixed(4);
  else s = p.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return fa(s).replace(".", "٫").replace(/,/g, "٬");
}
function g2j(gy, gm, gd) {
  const gdm = [0,31,59,90,120,151,181,212,243,273,304,334];
  let jy; if (gy > 1600){ jy = 979; gy -= 1600; } else { jy = 0; gy -= 621; }
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 365*gy + Math.floor((gy2+3)/4) - Math.floor((gy2+99)/100) + Math.floor((gy2+399)/400) - 80 + gd + gdm[gm-1];
  jy += 33*Math.floor(days/12053); days %= 12053;
  jy += 4*Math.floor(days/1461); days %= 1461;
  if (days > 365){ jy += Math.floor((days-1)/365); days = (days-1)%365; }
  let jm, jd;
  if (days < 186){ jm = 1 + Math.floor(days/31); jd = 1 + (days%31); }
  else { jm = 7 + Math.floor((days-186)/30); jd = 1 + ((days-186)%30); }
  return [jy, jm, jd];
}
const JM = ["فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور","مهر","آبان","آذر","دی","بهمن","اسفند"];
const WD = {6:"شنبه",0:"یکشنبه",1:"دوشنبه",2:"سه‌شنبه",3:"چهارشنبه",4:"پنجشنبه",5:"جمعه"};

const IDENT = {
 BTC:"قدیمی‌ترین و بزرگ‌ترین ارز دیجیتال جهان و لنگر کل بازار.",
 ETH:"دومین ارز بزرگ بازار و بستر اصلی قراردادهای هوشمند.",
 SOL:"یکی از سریع‌ترین بلاکچین‌ها و رقیب جدی اتریوم در قراردادهای هوشمند.",
 RAY:"توکن اصلی یکی از بزرگ‌ترین صرافی‌های غیرمتمرکز روی بلاکچین سولانا.",
 PUMP:"توکن پلتفرمی روی سولانا که ساخت سریع میم‌کوین را ممکن می‌کند.",
 DASH:"یکی از قدیمی‌ترین ارزها با تمرکز بر پرداخت سریع و کم‌هزینه.",
 ARB:"توکن شبکهٔ لایه‌دوم اربیتروم که تراکنش‌های اتریوم را ارزان‌تر می‌کند.",
 ZEC:"ارز متمرکز بر حریم خصوصی و تراکنش‌های محرمانه.",
 PEPE:"یکی از شناخته‌شده‌ترین میم‌کوین‌های بازار.",
 DOGE:"اولین و مشهورترین میم‌کوین بازار.",
 LINK:"شبکهٔ اوراکل که داده‌های دنیای واقعی را به قراردادهای هوشمند می‌رساند.",
 ADA:"بلاکچین کاردانو با رویکرد پژوهش‌محور به قراردادهای هوشمند.",
 DOT:"شبکهٔ پولکادات برای اتصال بلاکچین‌های مختلف به هم.",
 XRP:"ارز متمرکز بر انتقال ارزش سریع و کم‌هزینه میان کشورها.",
 BNB:"توکن اصلی اکوسیستم بایننس و زنجیرهٔ BNB.",
 AVAX:"بلاکچین سریع آوالانچ برای قراردادهای هوشمند.",
 TRX:"شبکهٔ ترون، پرکاربرد در انتقال استیبل‌کوین.",
 LTC:"لایت‌کوین، نسخهٔ سبک‌تر و سریع‌تر بیت‌کوین.",
 UNI:"توکن یونی‌سواپ، بزرگ‌ترین صرافی غیرمتمرکز اتریوم.",
 AAVE:"یکی از بزرگ‌ترین پروتکل‌های وام‌دهی غیرمتمرکز.",
 SUI:"بلاکچین لایه‌یک سریع با معماری تازه.",
 TON:"بلاکچینی که با اکوسیستم تلگرام گره خورده است.",
 NEAR:"بلاکچین لایه‌یک با تمرکز بر سادگی برای توسعه‌دهنده.",
 OP:"توکن اپتیمیزم، از شبکه‌های لایه‌دوم اتریوم.",
};
const RWA = {
 USOON:["نفت دیجیتال","Oil"], XAUT:["تترگلد","Gold"], SLVON:["نقره دیجیتال","Silver"],
 COPXON:["مس دیجیتال","Copper"], PPLTON:["پلاتین دیجیتال","Platinum"], UNGON:["گاز طبیعی دیجیتال","Natural Gas"],
};

function cleanEn(en){
  en = String(en||"").replace(/\s*\(.*?\)\s*/g," ").trim();
  if (/^[A-Z0-9 .]+$/.test(en) && en.replace(/[^A-Za-z]/g,"").length > 3)
    en = en.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  return en;
}
function nmeName(m){
  const tk = m.base_asset;
  if (RWA[tk]) return `${RWA[tk][0]} (${RWA[tk][1]}, ${tk})`;
  const f = m.fa_base_asset || tk, en = cleanEn(m.en_base_asset || tk);
  return `${f} (${en}, ${tk})`;
}
const mark = d => d >= 0 ? "🟢" : "🔴";
const sw = d => d >= 0 ? "مثبت" : "منفی";

function build(){
  const mk = JSON.parse(fs.readFileSync(MARKETS, "utf8"));
  let prev = {};
  if (fs.existsSync(SNAP)){ const sj = JSON.parse(fs.readFileSync(SNAP,"utf8")); prev = sj.prices||{}; }
  const markets = mk.result.markets;
  const by = {}; for (const m of markets) by[m.symbol] = m;

  const t = new Date(Date.now() + (3*60+30)*60000);
  const [jy,jm,jd] = g2j(t.getUTCFullYear(), t.getUTCMonth()+1, t.getUTCDate());
  const datestr = `${WD[t.getUTCDay()]} ${fa(jd)} ${JM[jm-1]} ${fa(jy)}`;
  const hhmm = fa(`${String(t.getUTCHours()).padStart(2,"0")}:${String(t.getUTCMinutes()).padStart(2,"0")}`);
  const hr = t.getUTCHours();
  const slot = (hr >= 4 && hr <= 14) ? "morning" : "evening";
  const win = slot === "morning" ? "از عصر دیروز تا امروز صبح" : "از صبح تا عصر امروز";

  const dOf = sym => { const m = by[sym]; if(!m) return null; const n = toF(m.price), p = toF(prev[sym]); if(n===null||p===null||p<=0) return null; return (n-p)/p*100; };

  const movers = [];
  for (const m of markets){
    if (m.quote_asset !== "USDT") continue;
    const n = toF(m.price), p = toF(prev[m.symbol]);
    if (n===null||p===null||p<=0) continue;
    const vol = toF(m.quote_volume_24h)||0; if (vol < VOL_MIN) continue;
    if (n === p) continue;
    const d = (n-p)/p*100, ch = toF(m.change_24h);
    if (Math.abs(d) >= 5 && (ch===null || Math.abs(ch) < Math.abs(d)*0.4)) continue;
    movers.push({m, b:m.base_asset, nm:nmeName(m), prev:p, now:n, d});
  }
  const gain = [...movers].sort((a,b)=>b.d-a.d);
  const lose = [...movers].sort((a,b)=>a.d-b.d);
  const maj = {BTC:dOf("BTCUSDT"), ETH:dOf("ETHUSDT"), SOL:dOf("SOLUSDT")};
  const btc7 = toF((by["BTCUSDT"]||{}).change_7D);
  const rwa = [];
  for (const [tk,[disp,en]] of Object.entries(RWA)){ const d = dOf(tk+"USDT"); if (d!==null) rwa.push({tk,disp,en,d}); }
  const rwaS = [...rwa].sort((a,b)=>Math.abs(b.d)-Math.abs(a.d));

  // ---- decide POST 2 category first (so pulse can avoid repeating the spotlight coin) ----
  let cat="movers", spot=null;
  for (const x of [gain[0],lose[0]]){ if(x && Math.abs(x.d)>=10 && IDENT[x.b]){ spot=x; break; } }
  const vals = Object.values(maj);
  const sameDir = vals.every(v=>v!==null) && (vals.every(v=>v>0)||vals.every(v=>v<0)) && (vals.reduce((a,b)=>a+Math.abs(b),0)/3 >= 1.2);
  if (spot) cat="spotlight"; else if (sameDir) cat="direction"; else if (rwaS[0] && Math.abs(rwaS[0].d)>=2) cat="rwa"; else cat="movers";

  const posts = [];
  const excl = new Set(["BTC","ETH","SOL", ...Object.keys(RWA), spot?spot.b:""]);

  // ---- POST 1: نبض بازار ----
  const calm = Object.values(maj).every(v => v!==null && Math.abs(v) < 1.2);
  const p1 = ["📊 نبض بازار","", calm ? "بازار در این بازه کم‌نوسان بود و بزرگان حرکت بزرگی نداشتند." : "بازار در این بازه حرکت محسوسی داشت.",""];
  for (const k of ["BTC","ETH","SOL"]){ const v=maj[k]; if(v===null) continue; p1.push(`${mark(v)} ${nmeName(by[k+"USDT"])} ${sw(v)} ${pct(v)} درصد`); }
  let big=null; for (const x of [...gain.slice(0,3), ...lose.slice(0,3)]){ if(x && !excl.has(x.b) && Math.abs(x.d)>=1.5){ if(!big||Math.abs(x.d)>Math.abs(big.d)) big=x; } }
  const rwaBig = (rwaS[0] && Math.abs(rwaS[0].d)>=1.5) ? rwaS[0] : null;
  p1.push("");
  if (big) p1.push(`بیرون از بزرگان، ${big.nm} با ${pct(big.d)} درصد ${big.d>=0?"رشد":"افت"} بیشترین توجه را گرفت.`);
  if (rwaBig) p1.push(`در بازار کالا، ${rwaBig.disp} (${rwaBig.en}) ${pct(rwaBig.d)} درصد ${rwaBig.d>=0?"بالا رفت":"پایین آمد"}.`);
  if (!big && !rwaBig) p1.push("حرکت معناداری بیرون از بزرگان هم دیده نشد.");
  if (btc7 !== null) p1.push(`در هفت روز گذشته، بیت‌کوین روی‌هم‌رفته ${pct(btc7)} درصد ${btc7>=0?"بالاتر":"پایین‌تر"} است، پس تصویر بلندمدت هم ${Math.abs(btc7)>=3?"جهت‌دار":"کم‌شیب"} می‌ماند.`);
  p1.push("","📌 این بازارها را در والکس می‌توان هم اسپات و هم تعهدی معامله کرد.");
  posts.push(p1.join("\n"));

  // ---- POST 2 ----
  if (cat==="spotlight"){
    const x=spot, up=x.d>=0, short=x.nm.split(" (")[0];
    const move = up
      ? `${short} در این بازه ${pct(x.d)} درصد جهش کرد و پرشتاب‌ترین بازار دلاری والکس شد.`
      : `${short} در این بازه ${pct(x.d)} درصد افت کرد و یکی از سنگین‌ترین ریزش‌های بازار دلاری والکس را رقم زد.`;
    posts.push([
      "🔦 ذره‌بین بازار","",
      `گاهی یک اسم کل بازه را می‌دزدد. این بار نوبت ${x.nm} بود.`,"",
      `${mark(x.d)} ${move} قیمت از ${price(x.prev)} به ${price(x.now)} دلار رسید.`,"",
      IDENT[x.b],"",
      `یک حرکت ${pct(x.d)} درصدی در یک بازه، هم فرصت است هم ریسک. حرکت‌های تند معمولا نوسان بالایی به‌دنبال دارند و همان‌قدر که سریع می‌آیند، می‌توانند سریع برگردند.`,
      "پیش از هر تصمیمی، اندازهٔ واقعی حرکت و عمق بازار را بسنج.","",
      "📌 بازار اسپات این ارز در والکس فعال است. تصمیم نهایی، همیشه با تحلیل خودت."
    ].join("\n"));
  } else if (cat==="direction"){
    const up = vals.every(v=>v>0);
    const order = ["BTC","ETH","SOL"].sort((a,b)=>Math.abs(maj[b])-Math.abs(maj[a]));
    const p2=[`🧭 جهت بازار، ${up?"امروز سبز":"امروز قرمز"}`,"", up?"این بازه بازار یک‌صدا بالا رفت.":"این بازه بازار یک‌صدا پایین آمد.",""];
    for (const k of order){ const v=maj[k]; p2.push(`${mark(v)} ${nmeName(by[k+"USDT"])} ${sw(v)} ${pct(v)} درصد`); }
    p2.push("",
      `نکته مهم برای خواندن بازار این است: وقتی بیت‌کوین، اتریوم و سولانا با هم و هم‌جهت حرکت می‌کنند، معمولا یعنی ${up?"اشتهای ریسک برگشته و پول تازه وارد بازار شده":"بازار محتاط شده و از دارایی‌های پرریسک فاصله گرفته"} است.`,
      "این با روزهایی که فقط یک ارز به‌تنهایی حرکت می‌کند فرق دارد. حرکت دسته‌جمعی معمولا جان بیشتری پشت خود دارد و دوام بهتری هم می‌گیرد.","",
      "📌 بازار اسپات و تعهدی این دارایی‌ها در والکس باز است.");
    posts.push(p2.join("\n"));
  } else if (cat==="rwa"){
    const p2=["🛢 رادار کالا و RWA","","بازار گواهی کالای والکس در این بازه:",""];
    for (const r of [...rwa].sort((a,b)=>b.d-a.d)) p2.push(`${mark(r.d)} ${r.disp} (${r.en}) ${sw(r.d)} ${pct(r.d)} درصد`);
    p2.push("",
      "کالاها همیشه هم‌جهت حرکت نمی‌کنند و همین تنوع، برای کسی که سبد متنوع می‌چیند مهم است.",
      "مزیت والکس این است که این کالاها به شکل توکن دیجیتال و روی دارایی واقعی در دسترس‌اند، بدون نیاز به حساب و کارگزار خارجی، از داخل ایران و با تومان.","",
      "📌 گواهی کالا در والکس به‌صورت اسپات معامله می‌شود.");
    posts.push(p2.join("\n"));
  } else {
    const rg = gain.filter(x=>x.d>0).slice(0,5), rl = lose.filter(x=>x.d<0).slice(0,5);
    const p2=["📈 برترین‌های بازه","", `${win}، بر مبنای بازارهای دلاری والکس.`,""];
    if (rg.length){ p2.push("📈 بیشترین رشد"); for(const x of rg) p2.push(`🟢 ${x.nm} ${sw(x.d)} ${pct(x.d)} درصد، از ${price(x.prev)} به ${price(x.now)} دلار`); p2.push(""); }
    if (rl.length){ p2.push("📉 بیشترین افت"); for(const x of rl) p2.push(`🔴 ${x.nm} ${sw(x.d)} ${pct(x.d)} درصد، از ${price(x.prev)} به ${price(x.now)} دلار`); p2.push(""); }
    if (!rg.length && !rl.length) p2.push("در این بازه حرکت قابل‌اتکایی در بازارهای دلاری ثبت نشد.","");
    p2.push("دامنهٔ حرکت‌ها را همین اعداد نشان می‌دهد؛ هر ردیف از بازاری با گردش واقعی آمده، نه بازارهای کم‌عمق.","",
      "📌 همهٔ این بازارها در والکس، اسپات و تعهدی، قابل معامله‌اند.");
    posts.push(p2.join("\n"));
  }

  const meta = {date:datestr,time:hhmm,slot,category:cat,window:win,fetched_at:mk.fetched_at,n_now:markets.length,n_prev:Object.keys(prev).length,n_movers:movers.length};
  return {posts, meta, markets, fetched_at:mk.fetched_at};
}

function writeOutputs({posts, meta, markets, fetched_at}){
  fs.mkdirSync(OUTBOX,{recursive:true}); fs.mkdirSync(path.dirname(SNAP),{recursive:true});
  const stamp = new Date().toISOString().replace(/[-:]/g,"").replace(/\..+/,"Z");
  const of = path.join(OUTBOX, `${stamp}-${meta.slot}.json`);
  fs.writeFileSync(of, JSON.stringify({run:`${meta.date} ${meta.time}`,meta,posts},null,2));
  const prices = {}; for (const m of markets) prices[m.symbol]=m.price;
  fs.writeFileSync(SNAP, JSON.stringify({ts:`${meta.date} ${meta.time}`,window:"live",fetched_at,prices}));
  return of;
}
function send(posts){
  const tok=process.env.TELEGRAM_BOT_TOKEN, chat=process.env.TELEGRAM_CHAT_ID;
  if(!tok||!chat){ console.log("[local] no telegram secrets, skipping send"); return Promise.resolve(); }
  const one = t => new Promise((res,rej)=>{
    const body=JSON.stringify({chat_id:chat,text:t,disable_web_page_preview:true});
    const req=https.request(`https://api.telegram.org/bot${tok}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{let j={};try{j=JSON.parse(d);}catch(e){} j.ok?res():rej(new Error(d));});});
    req.on("error",rej); req.write(body); req.end();
  });
  return posts.reduce((pr,t,i)=>pr.then(()=>one(t)).then(()=>{console.log("sent post",i+1);return new Promise(r=>setTimeout(r,2000));}), Promise.resolve());
}
(async()=>{
  const res = build();
  console.log("=== META ===", JSON.stringify(res.meta));
  res.posts.forEach((p,i)=>console.log(`\n----- POST ${i+1}  (${p.split(/\s+/).length} words) -----\n${p}`));
  if (process.env.WRITE==="1") console.log("\nwrote", writeOutputs(res));
  if (process.env.SEND==="1") await send(res.posts);
})();
