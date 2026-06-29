interface Env {
  DISCORD_PUBLIC_KEY:string; DISCORD_APPLICATION_ID:string; DISCORD_BOT_TOKEN:string;
  DISCORD_ALLOWED_CHANNEL_ID:string; ADMIN_TOKEN:string; GEMINI_API_KEY:string;
  GEMMA_MODEL:string; GEMINI_MODEL:string; GEMINI_FALLBACK_MODEL:string; OPENROUTER_API_KEY:string;
  OPENROUTER_MODEL:string; MAX_OUTPUT_TOKENS:string; MEMORY_MESSAGES:string;
  SYSTEM_PROMPT:string; GEMINI_QUEUE:Queue<Job>; MEMORY_STORE:DurableObjectNamespace;
}
interface User { id:string; username:string; global_name?:string|null }
interface Interaction { application_id:string; type:number; token:string; channel_id?:string; data?:{name?:string;options?:Array<{name:string;value?:unknown}>}; member?:{user?:User}; user?:User }
interface Job { applicationId:string; interactionToken:string; prompt:string; displayName:string; userId:string; channelId:string; provider:"gemini"|"openrouter" }
interface Msg { role:"user"|"assistant"; content:string }

const D="https://discord.com/api/v10", G="https://generativelanguage.googleapis.com/v1beta", O="https://openrouter.ai/api/v1/chat/completions";
const J={"content-type":"application/json; charset=utf-8"};

export class MemoryStore {
  constructor(private state:DurableObjectState){}
  async fetch(req:Request){
    const path=new URL(req.url).pathname;
    if(req.method==="GET"&&path==="/history") return Response.json({messages:(await this.state.storage.get<Msg[]>("m"))??[]});
    if(req.method==="DELETE"&&path==="/history"){await this.state.storage.delete("m");return Response.json({ok:true})}
    if(req.method==="POST"&&path==="/append"){
      const b=await req.json() as {messages:Msg[];max:number};
      const old=(await this.state.storage.get<Msg[]>("m"))??[];
      const next=[...old,...(b.messages??[])].slice(-Math.max(2,Math.min(40,b.max||12)));
      await this.state.storage.put("m",next); return Response.json({ok:true,count:next.length});
    }
    return new Response("Not found",{status:404});
  }
}

export default {
  async fetch(req:Request,env:Env){
    const u=new URL(req.url);
    if(req.method==="GET"&&u.pathname==="/health") return Response.json({ok:true,service:"dgc",memoryConfigured:!!env.MEMORY_STORE,memoryMessages:limit(env),gemmaModel:env.GEMMA_MODEL,geminiModel:env.GEMINI_MODEL,geminiFallbackModel:env.GEMINI_FALLBACK_MODEL,openRouterModel:env.OPENROUTER_MODEL});
    if(req.method==="GET"&&u.pathname==="/setup") return new Response(setup(),{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
    if(req.method==="POST"&&u.pathname==="/setup/register") return register(req,env);
    if(req.method==="POST"&&u.pathname==="/discord") return discord(req,env);
    return new Response("Not found",{status:404});
  },
  async queue(batch:MessageBatch<Job>,env:Env){for(const m of batch.messages){try{await process(m.body,env);m.ack()}catch(e){console.error(e);m.retry()}}}
} satisfies ExportedHandler<Env,Job>;

async function discord(req:Request,env:Env){
  const sig=req.headers.get("x-signature-ed25519"),ts=req.headers.get("x-signature-timestamp"),body=await req.text();
  if(!sig||!ts||!(await verify(body,sig,ts,env.DISCORD_PUBLIC_KEY))) return new Response("Invalid signature",{status:401});
  let i:Interaction; try{i=JSON.parse(body)}catch{return new Response("Invalid JSON",{status:400})}
  if(i.type===1)return Response.json({type:1});
  const cmd=i.data?.name;
  if(i.type!==2||!["ask","askd","forget"].includes(cmd||""))return reply("Unsupported command.",true);
  if(!env.DISCORD_ALLOWED_CHANNEL_ID||i.channel_id!==env.DISCORD_ALLOWED_CHANNEL_ID)return reply(`このBotは <#${env.DISCORD_ALLOWED_CHANNEL_ID}> でのみ使用できます。`,true);
  const user=i.member?.user??i.user;
  if(!user?.id||!i.channel_id)return reply("ユーザー情報を取得できませんでした。",true);
  if(cmd==="forget"){await clear(env,user.id,i.channel_id);return reply("🧠 このチャンネルでのあなたの会話メモリを削除しました。",true)}
  const prompt=String(i.data?.options?.find(x=>x.name==="prompt")?.value??"").trim();
  if(!prompt)return reply("質問内容が空です。",true);
  const provider=cmd==="askd"?"openrouter":"gemini";
  if(provider==="openrouter"&&!env.OPENROUTER_API_KEY)return reply("OPENROUTER_API_KEY が未設定です。",true);
  if(provider==="gemini"&&!env.GEMINI_API_KEY)return reply("GEMINI_API_KEY が未設定です。",true);
  await env.GEMINI_QUEUE.send({applicationId:i.application_id,interactionToken:i.token,prompt,displayName:user.global_name||user.username,userId:user.id,channelId:i.channel_id,provider});
  return new Response(JSON.stringify({type:5}),{headers:J});
}

async function process(job:Job,env:Env){
  try{
    const history=await historyOf(env,job.userId,job.channelId);
    if(job.provider==="openrouter"){
      const model=env.OPENROUTER_MODEL||"nvidia/nemotron-3-ultra-550b-a55b:free";
      await edit(job,`🤔 Thinking… 使用モデル：\`${model}\`\n🧠 メモリ：${history.length}件`);
      const text=await openrouter(model,job,history,env); await save(env,job,text);
      return finish(job,`> ✅ 使用モデル：\`${model}\`（OpenRouter）\n> 🧠 メモリ：ON\n\n${text}`);
    }

    const models=[env.GEMMA_MODEL||"gemma-4-31b-it",env.GEMINI_MODEL||"gemini-3.5-flash",env.GEMINI_FALLBACK_MODEL||"gemini-3.1-flash-lite"].filter((x,i,a)=>x&&a.indexOf(x)===i);
    let model=models[0],text="",usedIndex=0,lastError:unknown;
    for(let i=0;i<models.length;i++){
      model=models[i];
      await edit(job,`🤔 Thinking… 使用モデル：\`${model}\`${i?`\nフォールバック ${i}/${models.length-1}`:""}\n🧠 メモリ：${history.length}件`);
      try{text=await gemini(model,job,history,env);usedIndex=i;lastError=undefined;break}
      catch(e){lastError=e;const s=e instanceof Error?e.message:String(e);if(!/Gemini API (400|403|404|408|409|429|500|502|503|504):/.test(s)||i===models.length-1)throw e}
    }
    if(lastError)throw lastError;
    await save(env,job,text);
    const head=usedIndex?`> ⚠️ フォールバックモデル：\`${model}\``:`> ✅ 使用モデル：\`${model}\``;
    return finish(job,`${head}\n> 🧠 メモリ：ON\n\n${text}`);
  }catch(e){await edit(job,`⚠️ AIへの問い合わせに失敗しました。\n\`${safe(e instanceof Error?e.message:String(e)).slice(0,1500)}\``)}
}

async function openrouter(model:string,job:Job,h:Msg[],env:Env){
  const r=await fetch(O,{method:"POST",headers:{...J,authorization:`Bearer ${env.OPENROUTER_API_KEY}`,"HTTP-Referer":"https://dgc.sakus.org","X-Title":"dgc Discord Bot"},body:JSON.stringify({model,messages:[{role:"system",content:env.SYSTEM_PROMPT},...h,{role:"user",content:job.prompt}],max_tokens:tokens(env),temperature:.7})});
  const raw=await r.text();if(!r.ok)throw new Error(`OpenRouter API ${r.status}: ${compact(raw)}`);const x=JSON.parse(raw);const text=x.choices?.[0]?.message?.content?.trim();if(!text)throw new Error("OpenRouter returned no text");return text;
}
async function gemini(model:string,job:Job,h:Msg[],env:Env){
  const contents=[...h.map(x=>({role:x.role==="assistant"?"model":"user",parts:[{text:x.content}]})),{role:"user",parts:[{text:job.prompt}]}];
  const r=await fetch(`${G}/models/${encodeURIComponent(model)}:generateContent`,{method:"POST",headers:{...J,"x-goog-api-key":env.GEMINI_API_KEY},body:JSON.stringify({systemInstruction:{parts:[{text:env.SYSTEM_PROMPT}]},contents,generationConfig:{maxOutputTokens:tokens(env),temperature:.7}})});
  const raw=await r.text();if(!r.ok)throw new Error(`Gemini API ${r.status}: ${compact(raw)}`);const x=JSON.parse(raw);const text=x.candidates?.[0]?.content?.parts?.map((p:{text?:string})=>p.text||"").join("").trim();if(!text)throw new Error("Gemini returned no text");return text;
}

function stub(env:Env,user:string,channel:string){return env.MEMORY_STORE.get(env.MEMORY_STORE.idFromName(`${channel}:${user}`))}
async function historyOf(env:Env,user:string,channel:string){const r=await stub(env,user,channel).fetch("https://m/history");return ((await r.json()) as {messages:Msg[]}).messages??[]}
async function save(env:Env,j:Job,text:string){await stub(env,j.userId,j.channelId).fetch("https://m/append",{method:"POST",headers:J,body:JSON.stringify({messages:[{role:"user",content:j.prompt},{role:"assistant",content:text}],max:limit(env)})})}
async function clear(env:Env,user:string,channel:string){await stub(env,user,channel).fetch("https://m/history",{method:"DELETE"})}
function limit(env:Env){return Math.max(2,Math.min(40,Number(env.MEMORY_MESSAGES)||12))}
function tokens(env:Env){return Math.max(256,Math.min(8192,Number(env.MAX_OUTPUT_TOKENS)||2048))}

async function register(req:Request,env:Env){
  if(req.headers.get("authorization")!==`Bearer ${env.ADMIN_TOKEN}`)return Response.json({ok:false,error:"Unauthorized"},{status:401});
  const {guildId}=await req.json() as {guildId?:string};const route=guildId?`/applications/${env.DISCORD_APPLICATION_ID}/guilds/${guildId}/commands`:`/applications/${env.DISCORD_APPLICATION_ID}/commands`;const opt=[{name:"prompt",description:"質問内容",type:3,required:true,max_length:4000}];
  const r=await fetch(D+route,{method:"PUT",headers:{...J,authorization:`Bot ${env.DISCORD_BOT_TOKEN}`},body:JSON.stringify([{name:"ask",description:"Gemma/Geminiに質問（メモリ対応）",type:1,options:opt},{name:"askd",description:"NVIDIA Nemotronに質問（メモリ対応）",type:1,options:opt},{name:"forget",description:"自分の会話メモリを削除",type:1}])});
  const text=await r.text();return r.ok?Response.json({ok:true,message:"/ask・/askd・/forget を登録しました。"}):Response.json({ok:false,error:`Discord API ${r.status}: ${compact(text)}`},{status:r.status});
}
function setup(){return`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><style>body{font-family:system-ui;max-width:560px;margin:60px auto;background:#111;color:#eee}input,button{width:100%;box-sizing:border-box;padding:12px;margin:8px 0;background:#222;color:#fff;border:1px solid #555;border-radius:9px}</style><h1>dgc セットアップ</h1><input id=t type=password placeholder=ADMIN_TOKEN><input id=g placeholder="Guild ID"><button id=b>コマンドを登録</button><pre id=r></pre><script>b.onclick=async()=>{let x=await fetch('/setup/register',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+t.value},body:JSON.stringify({guildId:g.value.trim()||undefined})});r.textContent=JSON.stringify(await x.json(),null,2)}</script>`}
function reply(content:string,ephemeral:boolean){return Response.json({type:4,data:{content,flags:ephemeral?64:0,allowed_mentions:{parse:[]}}})}
async function edit(j:Job,content:string){const r=await fetch(`${D}/webhooks/${j.applicationId}/${j.interactionToken}/messages/@original`,{method:"PATCH",headers:J,body:JSON.stringify({content,allowed_mentions:{parse:[]}})});if(!r.ok)throw new Error(`Discord edit failed ${r.status}`)}
async function finish(j:Job,text:string){const c=split(text);await edit(j,c[0]);for(const x of c.slice(1))await fetch(`${D}/webhooks/${j.applicationId}/${j.interactionToken}`,{method:"POST",headers:J,body:JSON.stringify({content:x,allowed_mentions:{parse:[]}})})}
async function verify(body:string,sig:string,ts:string,keyHex:string){try{const key=await crypto.subtle.importKey("raw",hex(keyHex),{name:"Ed25519"},false,["verify"]);return crypto.subtle.verify({name:"Ed25519"},key,hex(sig),new TextEncoder().encode(ts+body))}catch{return false}}
function hex(s:string){const b=new Uint8Array(s.length/2);for(let i=0;i<s.length;i+=2)b[i/2]=parseInt(s.slice(i,i+2),16);return b}
function split(s:string,l=1950){const a:string[]=[];let x=s.trim();while(x.length>l){let n=Math.max(x.slice(0,l).lastIndexOf("\n"),x.slice(0,l).lastIndexOf(" "));if(n<l*.5)n=l;a.push(x.slice(0,n).trim());x=x.slice(n).trim()}if(x)a.push(x);return a}
function compact(s:string){return s.replace(/\s+/g," ").trim().slice(0,1000)}
function safe(s:string){return s.replace(/`/g,"ˋ")}
