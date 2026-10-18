/* Chromium + the ACTUAL 07-social.sql running in PostgreSQL/PGlite.
   Only the HTTP/GoTrue/Storage gateway is emulated; RPC authorization/data are not mocked.
   No fixture/relay is part of the production app or the public preview. */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes,randomUUID } from 'node:crypto';
import { fixtureDatabase,A,B,C } from './fixture-db.mjs';
const {chromium} = await import(process.env.WT_PLAYWRIGHT_MODULE || 'playwright');
const {db,as,call} = await fixtureDatabase();
const root = fileURLToPath(new URL('../../../',import.meta.url));
const artifacts = process.env.WT_SOCIAL_ARTIFACTS || path.join(process.env.HOME || '/tmp','.cache/wt-social-browser');
await fs.mkdir(artifacts,{recursive:true});
const errors = [], objects = new Map(), requests = [], contexts = [], browsers = [];
const flags = {missing:false,failPhoto:false,loseSend:false,offline:false,slowSearch:false,stall:false};
const tokens = {'test-token-a':A,'test-token-b':B,'test-token-c':C};
const sourceConfig = await fs.readFile(path.join(root,'assets/js/config.js'),'utf8');
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url,'http://test');
    const file = path.resolve(root,'.'+decodeURIComponent(url.pathname==='/' ? '/index.html' : url.pathname));
    if (path.relative(root,file).startsWith('..')) {res.writeHead(403);res.end();return;}
    const body = await fs.readFile(file);
    res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css'})[path.extname(file)] || 'application/octet-stream'});res.end(body);
  } catch {res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
const base = 'http://localhost:'+server.address().port;
const fulfill = async (route,data,status=200) => {try {await route.fulfill({status,contentType:'application/json; charset=utf-8',body:JSON.stringify(data)});} catch (_) {/* an aborted read or closed tab */}};
async function pageFor(user,viewport={width:1440,height:1000}) {
  const browser = await chromium.launch({headless:true,...(process.env.WT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.WT_CHROMIUM_EXECUTABLE} : {}),args:JSON.parse(process.env.WT_CHROMIUM_ARGS || '["--no-sandbox"]')});browsers.push(browser);
  const context = await browser.newContext({viewport,reducedMotion:'reduce',...(viewport.width<600?{isMobile:true,hasTouch:true}: {})});contexts.push(context);
  const page = await context.newPage();page.setDefaultTimeout(12000);
  page.on('pageerror',e=>errors.push(e.stack));page.on('dialog',d=>d.accept());
  if(process.env.WT_BROWSER_DEBUG) {page.on('console',m=>console.log('console',m.type(),m.text()));page.on('requestfailed',r=>console.log('failed',r.url(),r.failure()));}
  await page.addInitScript(({user,A,B,C})=>{
    window.testReadVisibility=[];const nativeFetch=window.fetch.bind(window);window.fetch=(url,options)=>{if(String(url).includes('/wt_social_mark_read'))window.testReadVisibility.push({hidden:document.getElementById('socialContent')?.hidden,height:document.getElementById('chatScroll')?.clientHeight,modal:!!document.querySelector('dialog[open]')});return nativeFetch(url,options);};
    if(user && !sessionStorage.getItem('test:seeded')) {
      const key=user===A?'a':user===B?'b':'c';
      localStorage.setItem('wt:session',JSON.stringify({access_token:'test-token-'+key,refresh_token:'test-refresh-'+key,expires_at:Date.now()+3600000,user:{id:user,name:user===A?'أحمد':user===B?'مريم':'سليم',email:'private-'+key+'@example.com'}}));
      sessionStorage.setItem('test:seeded','1');
    }
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.testCopied=text;}}});
    Object.defineProperty(navigator,'share',{configurable:true,value:undefined});
  },{user,A,B,C});
  await page.routeWebSocket('**',socket=>socket.close());
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin!==base) return route.abort();
    if(url.pathname==='/assets/js/config.js') return route.fulfill({contentType:'application/javascript',body:sourceConfig+'\nWT_CONFIG.supabase.url='+JSON.stringify(base+'/social-api')+';WT_CONFIG.supabase.anonKey="test-public-key";WT_CONFIG.javaServer.enabled=false;'});
    if(!url.pathname.startsWith('/social-api/')) return route.continue();
    requests.push({path:url.pathname,method:req.method(),user:tokens[req.headers().authorization?.replace('Bearer ','')] || null,body:req.postData()});
    if(flags.offline) return route.abort('internetdisconnected');
    if(flags.stall) return;
    const uid=tokens[req.headers().authorization?.replace('Bearer ','')] || null;
    const rpc=/\/rpc\/(wt_social_[a-z_]+)$/.exec(url.pathname);
    try {
      if(rpc) {
        if(!uid) return fulfill(route,{message:'Unauthorized'},401);
        if(flags.missing) return fulfill(route,{code:'PGRST202',message:'Missing RPC'},404);
        const args=req.postDataJSON() || {};
        if(flags.failPhoto && rpc[1]==='wt_social_save_profile' && args.p_patch?.avatar_path) {flags.failPhoto=false;return fulfill(route,{message:'تعذّر حفظ الصورة للاختبار'},500);}
        const result=await call(uid,rpc[1],args);
        if(flags.slowSearch && rpc[1]==='wt_social_search' && args.p_query==='مريم') await new Promise(r=>setTimeout(r,850));
        if(flags.loseSend && rpc[1]==='wt_social_send') {flags.loseSend=false;return fulfill(route,{message:'انقطع تأكيد الإرسال للاختبار'},503);}
        return fulfill(route,result);
      }
      if(url.pathname.endsWith('/rest/v1/rooms')) return fulfill(route,(await db.query('select room_id,title,created_at from public.rooms order by created_at desc limit 30')).rows);
      if(url.pathname.endsWith('/auth/v1/logout')) return fulfill(route,{});
      const publicImage=/\/storage\/v1\/object\/public\/wt-avatars\/(.+)$/.exec(url.pathname);
      if(publicImage) {const bytes=objects.get(publicImage[1]);if(!bytes) return fulfill(route,{},404);return route.fulfill({contentType:'image/webp',body:bytes});}
      const upload=/\/storage\/v1\/object\/wt-avatars\/(.+)$/.exec(url.pathname);
      if(upload && req.method()==='POST') {
        assert.equal(req.headers()['content-type'],'image/webp');
        const bytes=req.postDataBuffer();assert.ok(bytes.length<=262144);assert.equal(bytes.subarray(0,4).toString(),'RIFF');assert.equal(bytes.subarray(8,12).toString(),'WEBP');
        await as(uid,"insert into storage.objects(bucket_id,name,metadata) values('wt-avatars',$1,'{\"mimetype\":\"image/webp\"}')",[upload[1]]);objects.set(upload[1],bytes);return fulfill(route,{Key:'wt-avatars/'+upload[1]});
      }
      if(url.pathname.endsWith('/storage/v1/object/wt-avatars') && req.method()==='DELETE') {
        const deleted=[];
        for(const name of req.postDataJSON().prefixes) {const rows=(await as(uid,"delete from storage.objects where bucket_id='wt-avatars' and name=$1 returning name",[name])).rows;for(const row of rows){objects.delete(row.name);deleted.push(row);}}
        return fulfill(route,deleted);
      }
      return fulfill(route,{},404);
    } catch(error) {return fulfill(route,{message:error.message,code:error.code},error.code==='42501'?403:400);}
  });
  return page;
}
const ready=page=>page.waitForFunction(()=>!document.getElementById('socialContent').hidden);
const go=async(page,url)=>{await page.goto(base+'/'+url);await ready(page);};
const wait=async(page,fn,arg)=>page.waitForFunction(fn,arg,{polling:50,timeout:14000});
const sqlMessages=thread=>call(A,'wt_social_messages',{p_thread:thread});
async function png(page) {
  const data=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=900;c.height=650;const x=c.getContext('2d');const g=x.createLinearGradient(0,0,900,650);g.addColorStop(0,'#c8eed5');g.addColorStop(1,'#4f655a');x.fillStyle=g;x.fillRect(0,0,900,650);x.fillStyle='#233a2d';x.beginPath();x.arc(450,270,130,0,Math.PI*2);x.fill();x.beginPath();x.ellipse(450,650,250,210,0,0,Math.PI*2);x.fill();return c.toDataURL('image/png').split(',')[1];});
  return Buffer.from(data,'base64');
}
async function crop(page,bytes,save=true) {
  await page.setInputFiles('#photoInput',{name:'phone-photo.png',mimeType:'image/png',buffer:bytes});
  await wait(page,()=>document.getElementById('photoDialog').open && !document.getElementById('photoSave').disabled);
  await page.locator('#photoZoom').evaluate(el=>{el.value='1.3';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.click('#rotatePhoto');await page.focus('#photoCanvas');await page.keyboard.press('ArrowRight');
  if(save) await page.click('#photoSave');
}
let assertions=0;
try {
  await call(B,'wt_social_save_profile',{p_patch:{username:'maryam',bio:'أحب القصص التي تبقى بعد شارة النهاية.',discoverable:true,interests:['scifi','drama'],favorites:['Interstellar'],mood:'quiet'}});
  for(const [i,name,genres] of [[0,'ليان',['animation','scifi']],[1,'ياسين',['documentary','scifi']],[2,'نور',['comedy','shorts']],[3,'آدم',['mystery','drama']]]) {
    const uid=randomUUID();await db.query('insert into auth.users(id,raw_user_meta_data) values($1,$2)',[uid,JSON.stringify({full_name:name})]);
    await call(uid,'wt_social_save_profile',{p_patch:{username:'watchmate_'+i,discoverable:true,interests:genres,bio:'لكل حكاية وقت، ولكل سهرة رفيق.',accent:['violet','amber','rose','mint'][i],mood:i%2?'open':'none'}});
  }
  const guest=await pageFor(null,{width:390,height:844});
  const before=requests.length;
  for(const file of ['profile.html','friends.html','messages.html']) {await guest.goto(base+'/'+file);await wait(guest,()=>document.querySelector('#socialState').textContent.includes('لك مساحة'));assert.equal(await guest.locator('#socialContent').isVisible(),false);assert.match(await guest.locator('#socialState a').first().getAttribute('href'),/auth\.html\?reauth=1&next=/);assertions+=2;}
  assert.equal(requests.length,before);assertions++;
  console.log('✓ Guest privacy gate: all three pages, no social requests');
  const alice=await pageFor(A), bob=await pageFor(B);
  flags.missing=true;await alice.goto(base+'/profile.html');await wait(alice,()=>document.querySelector('#socialState').textContent.includes('خطوة تفعيل'));assert.match(await alice.locator('#socialState').innerText(),/07-social\.sql/);assertions++;
  flags.missing=false;await alice.click('#socialRetry');await ready(alice);
  assert.equal(await alice.locator('#profileName').innerText(),'أحمد');assertions++;
  await alice.click('[data-profile-action="edit"]');await alice.fill('#editName','أحمد بن عمر');await alice.fill('#editUsername','ahmed_orbit');await alice.fill('#editBio','أفضّل الحكايات التي تفتح نافذة جديدة. رفيق لسهرة هادئة، وسؤال طويل بعد النهاية.');await alice.fill('#editLocation','سطيف، الجزائر');await alice.fill('#editWebsite','https://example.com');
  await alice.click('[data-edit-tab="taste"]');for(const genre of ['scifi','documentary','mystery','drama']) await alice.click('[data-genre="'+genre+'"]');
  await alice.fill('#favorite0','Interstellar');await alice.fill('#favorite1','The Grand Budapest Hotel');await alice.fill('#favorite2','رحلة إلى القمر');await alice.click('[data-accent-choice="violet"]');await alice.click('[data-cover-choice="prism"]');
  await alice.click('[data-edit-tab="privacy"]');await alice.check('#prefDiscoverable');await alice.click('#saveProfile');await wait(alice,()=>document.querySelector('#profileSaved').textContent.includes('تم حفظ'));
  const saved=await call(A,'wt_social_profile');assert.equal(saved.username,'ahmed_orbit');assert.equal(saved.cover,'prism');assert.equal(saved.discoverable,true);assert.equal((await db.query('select raw_user_meta_data from auth.users where id=$1',[A])).rows[0].raw_user_meta_data.full_name,'أحمد بن عمر');
  const session=await alice.evaluate(()=>JSON.parse(localStorage.getItem('wt:session')));assert.equal(session.access_token,'test-token-a');assert.equal(session.user.name,'أحمد بن عمر');assertions+=6;
  await alice.click('#closeEditor');await alice.click('[data-profile-action="edit"]');await alice.fill('#editBio','تعديل لا أريد حفظه');await alice.click('#closeEditor');await alice.click('#confirmNo');assert.equal(await alice.locator('#profileEditor').isVisible(),true);await alice.click('#closeEditor');await alice.click('#confirmYes');assertions++;
  const bytes=await png(alice);
  await alice.setInputFiles('#photoInput',{name:'bad.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg onload="alert(1)"></svg>')});await wait(alice,()=>!document.querySelector('#profileError').hidden);assert.equal(await alice.locator('#photoDialog').evaluate(el=>el.open),false);assertions++;
  await crop(alice,bytes);await wait(alice,()=>!document.getElementById('photoDialog').open);await wait(alice,()=>document.querySelector('#profileAvatar img')?.naturalWidth===512);
  const firstPath=(await call(A,'wt_social_profile')).avatar_path;assert.match(firstPath,new RegExp('^'+A+'/[a-f0-9]{48}\\.webp$'));assert.equal(objects.size,1);assertions+=2;
  flags.failPhoto=true;await crop(alice,bytes);await wait(alice,()=>!document.querySelector('#photoError').hidden);assert.equal((await call(A,'wt_social_profile')).avatar_path,firstPath);assert.equal(objects.size,1);assertions+=2;
  await alice.click('#photoSave');await wait(alice,()=>!document.getElementById('photoDialog').open);assert.equal(objects.size,1);assert.ok(!objects.has(firstPath));assertions+=2;
  await alice.click('[data-profile-action="remove-photo"]');await alice.click('#confirmNo');assert.ok((await call(A,'wt_social_profile')).avatar_path);await alice.click('[data-profile-action="remove-photo"]');await alice.click('#confirmYes');await wait(alice,()=>!document.querySelector('#profileAvatar img'));assert.equal(objects.size,0);assertions+=2;
  await crop(alice,bytes);await wait(alice,()=>!document.getElementById('photoDialog').open);
  await alice.click('[data-profile-action="preview"]');assert.equal(await alice.locator('#photoOpen').isDisabled(),true);assert.equal(await alice.locator('#profileCompletion').isVisible(),false);await alice.click('#endPreview');await alice.click('[data-profile-action="share"]');assert.match(await alice.evaluate(()=>window.testCopied),new RegExp('profile\\.html\\?u='+A));assertions+=3;
  await call(A,'wt_social_save_profile',{p_patch:{accent:'mint',cover:'orbit'}});await go(alice,'profile.html');await alice.screenshot({path:path.join(artifacts,'social-profile-desktop.png'),fullPage:true});
  console.log('✓ Profile: details/privacy, real SQL persistence/auth metadata, phone crop/upload/rollback/delete and visitor preview');
  await go(alice,'friends.html');await alice.fill('#friendQuery','@maryam');await wait(alice,id=>document.querySelectorAll('.friend-card').length===1 && document.querySelector('.friend-card').dataset.person===id,B);
  await alice.click('[data-friend-action="request"]');await wait(alice,()=>!!document.querySelector('[data-friend-action="cancel"]'));
  assert.equal((await call(B,'wt_social_friends',{p_tab:'incoming'})).people[0].user_id,A);assertions++;
  await go(bob,'friends.html?tab=incoming');await bob.click('[data-friend-action="accept"]');await wait(bob,()=>document.querySelector('#friendsEmpty').textContent.includes('لا طلبات'));
  await go(alice,'friends.html?tab=friends');await wait(alice,()=>!!document.querySelector('.friend-card a[href^="messages.html?with="]'));assert.equal((await call(A,'wt_social_friends')).people.length,1);assertions++;
  await go(alice,'friends.html');flags.slowSearch=true;await alice.fill('#friendQuery','مريم');await alice.waitForTimeout(420);await alice.fill('#friendQuery','ياسين');await wait(alice,()=>document.querySelectorAll('.friend-card').length===1 && document.querySelector('.friend-card h3').textContent==='ياسين');await alice.waitForTimeout(900);assert.equal(await alice.locator('.friend-card h3').innerText(),'ياسين');flags.slowSearch=false;assertions++;
  await alice.fill('#friendQuery','');await wait(alice,()=>document.querySelectorAll('.friend-card').length===5);await alice.screenshot({path:path.join(artifacts,'social-friends-desktop.png'),fullPage:true});
  console.log('✓ Friend search: opt-in discovery, real shared tastes, request/accept and out-of-order response cancellation');
  await go(alice,'messages.html?with='+B);await wait(alice,()=>!document.querySelector('#chatInput').disabled && !document.querySelector('#chatActive').hidden);
  await alice.fill('#chatInput','جاهز لسهرة خيال علمي؟');await alice.click('#chatSend');await wait(alice,()=>document.querySelectorAll('[data-message]').length===1 && !document.querySelector('[data-pending]'));
  let thread=(await call(A,'wt_social_threads')).threads[0].id;let rows=(await sqlMessages(thread)).messages;const first=rows[0];
  await go(bob,'messages.html?with='+A);await wait(bob,()=>document.querySelectorAll('[data-message]').length===1);
  await wait(alice,()=>!!document.querySelector('.dm-meta .is-read'));
  const bootReads=await bob.evaluate(()=>window.testReadVisibility);assert.ok(bootReads.length>0&&bootReads.every(r=>!r.hidden&&r.height>0&&!r.modal),'no receipt while the initial chat is still hidden behind its loading gate');assertions++;
  await bob.click('[data-message="'+first.id+'"] [data-msg-action="reply"]');await bob.fill('#chatInput','بكل سرور. نختار شيئًا يبقى معنا.');await bob.click('#chatSend');await wait(alice,()=>document.querySelectorAll('[data-message]').length===2);
  assert.match(await alice.locator('.dm-quote').innerText(),/جاهز/);assertions++;
  await alice.fill('#chatInput','مسودة عادية قبل التعديل');await alice.click('[data-message="'+first.id+'"] [data-msg-action="edit"]');await alice.fill('#chatInput','تعديل حقيقي للرسالة الأولى');await alice.click('#chatSend');await wait(bob,id=>document.querySelector('[data-message="'+id+'"] .dm-text').textContent==='تعديل حقيقي للرسالة الأولى',first.id);
  assert.equal(await alice.locator('#chatInput').inputValue(),'مسودة عادية قبل التعديل');assert.equal((await sqlMessages(thread)).messages.length,2);assertions+=2;
  await alice.click('[data-message="'+first.id+'"] [data-msg-action="delete"]');await alice.click('#confirmYes');await wait(bob,()=>document.querySelector('.dm-quote').textContent.includes('رسالة محذوفة'));assertions++;
  await alice.fill('#chatInput','<img src=x onerror="window.testXSS=1"> نص حرفي');await alice.click('#chatSend');await wait(bob,()=>document.querySelector('#chatMessages').textContent.includes('<img src=x'));assert.equal(await bob.evaluate(()=>window.testXSS),undefined);assert.equal(await bob.locator('#chatMessages img').count(),0);assertions+=2;
  await alice.click('#chatInvite');await alice.click('[data-invite-room="ROOM01"]');await wait(bob,()=>!!document.querySelector('.dm-invite[href="room.html?id=ROOM01"]'));assertions++;
  flags.loseSend=true;await alice.fill('#chatInput','إرسال آمن عند انقطاع التأكيد');await alice.click('#chatSend');await wait(alice,()=>!!document.querySelector('[data-pending-action="retry"]'));const pendingNonce=await alice.locator('[data-pending]').getAttribute('data-pending');await alice.click('[data-pending-action="retry"]');await wait(alice,()=>!document.querySelector('[data-pending]'));
  assert.equal((await db.query('select count(*) n from public.wt_dm_messages where nonce=$1',[pendingNonce])).rows[0].n,1);assertions++;
  flags.offline=true;await alice.fill('#chatInput','مسودة إرسال أثناء انقطاع الشبكة');await alice.click('#chatSend');await wait(alice,()=>!!document.querySelector('[data-pending-action="retry"]'));
  const offlineNonce=await alice.locator('[data-pending]').getAttribute('data-pending');await alice.reload();await wait(alice,()=>!!document.querySelector('#socialRetry'));
  flags.offline=false;await alice.click('#socialRetry');await ready(alice);await wait(alice,()=>!!document.querySelector('[data-pending-action="retry"]'));await alice.click('[data-pending-action="retry"]');await wait(alice,()=>!document.querySelector('[data-pending]'));
  assert.equal((await db.query('select count(*) n from public.wt_dm_messages where nonce=$1',[offlineNonce])).rows[0].n,1);assertions++;
  await alice.fill('#chatInput','مسودة تبقى بعد إعادة الفتح');await alice.reload();await ready(alice);assert.equal(await alice.locator('#chatInput').inputValue(),'مسودة تبقى بعد إعادة الفتح');assertions++;
  await alice.fill('#chatInput','');
  await call(B,'wt_social_save_profile',{p_patch:{read_receipts:false}});await bob.reload();await ready(bob);await wait(alice,()=>!document.querySelector('.dm-meta .is-read'));assertions++;
  console.log('✓ Messages: private friend thread, read receipts/opt-out, reply/edit/delete, literal XSS-safe text, room invite, persistent draft and idempotent lost-response retry');
  let old;
  for(let i=0;i<58;i++) {const m=await call(i%3===0?B:A,'wt_social_send',{p_thread:thread,p_body:'رسالة من سجل المشاهدة '+(i+1),p_nonce:randomBytes(24).toString('hex')});if(i===0) old=m;}
  await call(B,'wt_social_send',{p_thread:thread,p_body:'رد على فكرة قديمة',p_reply:old.id,p_nonce:randomBytes(24).toString('hex')});
  await alice.reload();await ready(alice);await bob.reload();await ready(bob);await wait(bob,()=>document.querySelectorAll('[data-message]').length===50);
  await call(B,'wt_social_edit_message',{p_message:old.id,p_body:'فكرة قديمة عُدّلت الآن'});await wait(bob,()=>document.querySelector('.dm-quote')?.textContent.includes('فكرة قديمة عُدّلت الآن'));assert.equal(await bob.locator('[data-message]').count(),50);assertions++;
  await call(B,'wt_social_edit_message',{p_message:old.id,p_delete:true});await wait(bob,()=>document.querySelector('.dm-quote')?.textContent.includes('رسالة محذوفة'));assertions++;
  await alice.locator('#chatScroll').evaluate(el=>{el.scrollTop=0;});await alice.click('#messagesMore');await wait(alice,()=>document.querySelectorAll('[data-message]').length>50);assert.equal(await alice.locator('[data-message]').count(),(await sqlMessages(thread)).messages.length+(await call(A,'wt_social_messages',{p_thread:thread,p_before:(await sqlMessages(thread)).messages[0].id})).messages.length);assertions++;
  await bob.locator('#chatScroll').evaluate(el=>{el.scrollTop=0;});await call(B,'wt_social_save_profile',{p_patch:{read_receipts:true}});
  const beforeRead=(await sqlMessages(thread)).peer_read_id;
  const incoming=await call(A,'wt_social_send',{p_thread:thread,p_body:'رسالة أثناء قراءة السجل',p_nonce:randomBytes(24).toString('hex')});await wait(bob,()=>!document.querySelector('#chatNewMessages').hidden);
  assert.equal((await sqlMessages(thread)).peer_read_id,beforeRead,'scrolling old history does not falsely mark new messages read');assertions++;
  await bob.click('#chatNewMessages');await wait(alice,()=>!!document.querySelector('.dm-meta .is-read'));
  assert.equal((await sqlMessages(thread)).peer_read_id,incoming.id);assertions++;
  await bob.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
  const hiddenBefore=(await sqlMessages(thread)).peer_read_id;const hiddenMessage=await call(A,'wt_social_send',{p_thread:thread,p_body:'رسالة أثناء إخفاء الصفحة',p_nonce:randomBytes(24).toString('hex')});await alice.waitForTimeout(4400);assert.equal((await sqlMessages(thread)).peer_read_id,hiddenBefore);assertions++;
  await bob.evaluate(()=>{delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));});await wait(bob,body=>document.querySelector('#chatMessages').textContent.includes(body),hiddenMessage.body);
  await alice.screenshot({path:path.join(artifacts,'social-messages-desktop.png'),fullPage:true});
  await alice.setViewportSize({width:390,height:844});await go(alice,'profile.html');assert.ok(await alice.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await alice.screenshot({path:path.join(artifacts,'social-profile-mobile.png'),fullPage:true});assertions++;
  await go(alice,'friends.html');await wait(alice,()=>document.querySelectorAll('.friend-card').length===5);assert.ok(await alice.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await alice.screenshot({path:path.join(artifacts,'social-friends-mobile.png'),fullPage:true});assertions++;
  await go(alice,'messages.html?thread='+thread);await wait(alice,()=>!document.querySelector('#chatComposeArea').hidden);const frame=await alice.locator('.messages-frame').boundingBox();const compose=await alice.locator('#chatInput').boundingBox();assert.ok(compose.y+compose.height<844-65);assert.ok(frame.width<390);assertions+=2;await alice.screenshot({path:path.join(artifacts,'social-messages-mobile.png'),fullPage:true});
  for(const width of [320,360,768,1024]) {await alice.setViewportSize({width,height:844});for(const file of ['profile.html','friends.html','messages.html?thread='+thread]) {await go(alice,file);assert.ok(await alice.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),file+' overflows at '+width);assertions++;}}
  const mobile=await pageFor(A,{width:390,height:844});await go(mobile,'profile.html');await crop(mobile,await png(mobile),false);
  const beforePan=await mobile.locator('#photoCanvas').evaluate(c=>c.toDataURL());const box=await mobile.locator('#photoCanvas').boundingBox();
  const cdp=await mobile.context().newCDPSession(mobile);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+box.width/2+32,y:box.y+box.height/2+24}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.notEqual(await mobile.locator('#photoCanvas').evaluate(c=>c.toDataURL()),beforePan,'real phone touch gesture pans the crop');assertions++;
  await mobile.click('#photoSave');await wait(mobile,()=>!document.querySelector('#photoDialog').open);await wait(mobile,()=>document.querySelector('#profileAvatar img')?.naturalWidth===512);assertions++;
  await go(mobile,'messages.html?thread='+thread);await mobile.fill('#chatInput','سطر أول');await mobile.press('#chatInput','Enter');assert.equal(await mobile.locator('#chatInput').inputValue(),'سطر أول\n');assertions++;
  await mobile.setViewportSize({width:390,height:560});await mobile.waitForTimeout(80);const compact=await mobile.locator('#chatInput').boundingBox();assert.ok(compact.y+compact.height<560-65);assertions++;
  await mobile.setViewportSize({width:390,height:844});await mobile.screenshot({path:path.join(artifacts,'social-messages-touch.png'),fullPage:true});
  await mobile.context().close();
  console.log('✓ History/change cursors, quote updates outside loaded history, pagination, visible-bottom read policy, mobile chat and 320–1440px layouts');
  await alice.setViewportSize({width:1440,height:1000});await go(alice,'messages.html?thread='+thread);await alice.fill('#chatInput','مسودة محلية تُحذف عند الخروج');await alice.click('#chatBlock');await alice.click('#confirmYes');await wait(alice,()=>!document.querySelector('#chatRestriction').hidden);
  await wait(bob,()=>!document.querySelector('#chatRestriction').hidden);assert.equal((await call(B,'wt_social_messages',{p_thread:thread})).can_send,false);assertions++;
  await go(alice,'friends.html?tab=blocked');await alice.click('[data-friend-action="unblock"]');await wait(alice,()=>document.querySelector('#friendsEmpty').textContent.includes('هادئة'));assert.equal((await call(A,'wt_social_profile',{p_user:B})).relation,'none');assertions++;
  await go(alice,'messages.html');assert.equal(await alice.locator('.thread-item').count(),1);assertions++;
  await alice.goto(base+'/auth.html?next='+encodeURIComponent('profile.html?edit=privacy'));await alice.waitForURL('**/profile.html?edit=privacy');await ready(alice);assert.equal(await alice.locator('#edit-privacy').isVisible(),true);assertions++;
  for(let i=0;i<32;i++){const uid=randomUUID();await db.query('insert into auth.users(id) values($1)',[uid]);await call(uid,'wt_social_save_profile',{p_patch:{username:'page_'+i,display_name:'رفيق '+i,discoverable:true}});}
  await go(alice,'friends.html');await wait(alice,()=>document.querySelectorAll('.friend-card').length===30);await alice.click('#friendsMore');await wait(alice,()=>document.querySelectorAll('.friend-card').length===37);
  assert.equal(await alice.locator('.friend-card').evaluateAll(nodes=>new Set(nodes.map(n=>n.dataset.person)).size),37);assertions++;
  await go(alice,'messages.html?thread='+thread);await alice.click('#socialLogout');await alice.click('#confirmYes');await alice.waitForURL('**/index.html');
  assert.equal(await alice.evaluate(()=>localStorage.getItem('wt:session')),null);assert.equal(await alice.evaluate(uid=>Object.keys(localStorage).some(k=>k.startsWith('wt:dm-draft:'+uid+':')),A),false);assertions+=2;
  assert.deepEqual(errors,[]);assertions++;
  console.log(`Social Chromium: ${assertions} assertions passed; actual PostgreSQL RPCs/roles/RLS behind the test gateway. Screenshots: ${artifacts}`);
} finally {
  for(const context of contexts) await context.close().catch(()=>{});
  for(const browser of browsers) await browser.close().catch(()=>{});
  await new Promise(resolve=>server.close(resolve));await db.close();
}
