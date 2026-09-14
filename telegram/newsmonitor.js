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

function get(url, redirects=0){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const req=https.request(u,{method:"GET",headers:{"User-Agent":"Mozilla/5.0 (compatible; WallexDeskBot/1.0)","Accept":"*/*"},timeout:25000},res=>{
      if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location&&redirects<4){res.resume();return resolve(get(new URL(res.headers.location,url).href,redirects+1));}
      let d="";res.on("data",c=>d+=c);res.on("end",()=>resolve({status:res.statusCode,body:d}));
    });
    req.on("error",reject);req.on("timeout",()=>req.destroy(new Error("timeout")));req.end();
  });
}
const strip=s=>(s||"").replace(/<!\[CDATA\[|\]\]>/g,"").replace(/<[^>]+>/g," ").replace(/&[a-z#0-9]+;/gi," ").replace(/\s+/g," ").trim();
function tag(b,n){const m=b.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`,"i"));return m?m[1]:"";}
function parseRSS(xml,src){
  const items=[];const blocks=xml.match(/<item[\s\S]*?<\/item>/gi)||xml.match(/<entry[\s\S]*?<\/entry>/gi)||[];
  for(const b of blocks){
    let link=strip(tag(b,"link"));if(!link){const m=b.match(/<link[^>]*href="([^"]+)"/i);if(m)link=m[1];}
    const title=strip(tag(b,"title"));
    const dateStr=strip(tag(b,"pubDate"))||strip(tag(b,"published"))||strip(tag(b,"updated"));
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
      res=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>resolve({status:res.statusCode,data:d}));});
    req.on("error",reject);req.on("timeout",()=>req.destroy(new Error("llm timeout")));req.write(body);req.end();
  });
}
function llmUrls(){
  let base=(process.env.LLM_BASE_URL||"").replace(/\/+$/,"");const urls=[];
  if(base){if(/\/chat\/completions$/.test(base))urls.push(base);else if(/\/v\d+$/.test(base))urls.push(base+"/chat/completions");else urls.push(base+"/chat/completions",base+"/v1/chat/completions");}
  return [...new Set(urls)];
}
async function llmChat(messages,maxTokens){
  const key=process.env.LLM_API_KEY,model=process.env.LLM_MODEL;
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
  let t=await llmChat([{role:"system",content:WRITE_SYS},{role:"user",content:u}],8000);
  return t.trim();
}

function tgSend(text){
  const tok=process.env.TELEGRAM_BOT_TOKEN,chat=process.env.TELEGRAM_CHAT_ID;
  const body=JSON.stringify({chat_id:chat,text,disable_web_page_preview:false});
  return new Promise((resolve,reject)=>{
    const req=https.request(`https://api.telegram.org/bot${tok}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},
      r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{let j={};try{j=JSON.parse(d);}catch{} j.ok?resolve():reject(new Error(d));});});
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
    footer+= c.tsKnown ? `\n🕒 انتشار در منبع: ${tehranStamp(c.ts)} به وقت تهران، حدود ${ago(c.ts)}` : `\n🕒 زمان انتشار در منبع نامشخص`;
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
