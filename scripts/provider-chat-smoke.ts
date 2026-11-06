// Read-only live smoke: synthetic prompts only, no app endpoints, cache writes or stored messages.
// Bundle with esbuild, stream the reviewed bundle to node stdin as growth from the app directory.
import pg from "pg";
import { createDecipheriv } from "node:crypto";
import { requestProviderChat } from "../src/lib/ai/chat-transport";
import { testProviderChat } from "../src/lib/ai/provider-test";

async function main() {
  process.loadEnvFile('/home/growth/.env.production');
  const id = process.argv[2];
  if (!id || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('provider_id_required');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query('BEGIN READ ONLY');
    if ((await db.query('SELECT current_database() AS name')).rows[0].name !== 'growth') throw new Error('wrong_database');
    const row = (await db.query('SELECT provider,kinds,base_url,model,encrypted_api_key FROM research_providers WHERE id=$1 AND is_enabled=true',[id])).rows[0];
    if (!row || row.kinds === 'search') throw new Error('chat_provider_required');
    const parts = row.encrypted_api_key.split(':');
    if (parts.length !== 5 || parts.slice(0,2).join(':') !== 'enc:v1') throw new Error('key_format');
    const cipher = createDecipheriv('aes-256-gcm',Buffer.from(process.env.APP_ENCRYPTION_KEY!, 'base64'),Buffer.from(parts[2],'base64'));
    cipher.setAuthTag(Buffer.from(parts[3],'base64'));
    const key = Buffer.concat([cipher.update(Buffer.from(parts[4],'base64')),cipher.final()]).toString('utf8');
    const config={provider:row.provider,baseUrl:row.base_url,model:row.model};
    const tested=await testProviderChat(config,key);
    console.log(JSON.stringify({step:'chat_test',ok:tested.ok,code:tested.code,modelCount:tested.models.length,exactModelMatch:tested.models.includes(row.model)}));
    for(const task of ['translation','suggest_reply']) {
      const outcome=await requestProviderChat(config,key,task==='translation'
        ? {system:'Translate the user text into English. Return JSON only with sourceLanguage and translatedText.',user:'Bonjour.',maxTokens:1024,json:true}
        : {system:'Draft a short synthetic reply. Return JSON only with subject, body, and needsFounderInput.',user:'Synthetic test: please acknowledge this note.',maxTokens:900,json:true});
      let valid=false;
      if(outcome.ok) {
        try {const data=JSON.parse(outcome.text); valid=task==='translation'
          ? typeof data.sourceLanguage==='string' && typeof data.translatedText==='string' && !!data.translatedText.trim()
          : typeof data.subject==='string' && typeof data.body==='string' && !!data.body.trim();} catch {}
      }
      console.log(JSON.stringify({step:task,ok:outcome.ok,validJsonOutput:valid,code:outcome.ok?null:outcome.code}));
    }
    await db.query('ROLLBACK');
  } finally {await db.end();}
}
main().catch(()=>{console.log(JSON.stringify({code:'smoke_failed'}));process.exitCode=1;});
