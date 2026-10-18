/* Dependency-free security/contract tests for the new static social client. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
const source = name => readFileSync(new URL('../../assets/js/' + name + '.js',import.meta.url),'utf8');
const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const oldPath = id + '/' + 'a'.repeat(48) + '.webp';
let profile = {user_id:id,display_name:'أحمد',username:'ahmed',avatar_path:oldPath,interests:['scifi'],favorites:[],bio:'',location:'',website:'',mood:'none',accent:'mint',cover:'orbit',discoverable:false,allow_requests:true,read_receipts:true,show_friend_count:false};
let failSave = false, stall = false, bodyStall = false, crossActor = false, authMeta = null;
const trace = [], events = [], storage = {};
Object.defineProperties(storage,{
  getItem:{value:key => Object.hasOwn(storage,key) ? storage[key] : null},
  setItem:{value:(key,value) => { storage[key] = String(value); }},
  removeItem:{value:key => { delete storage[key]; }}
});
const reply = (data,status=200) => ({ok:status>=200 && status<300,status,json:async () => data});
const ctx = { console,URL,URLSearchParams,Uint8Array,Blob,AbortController,crypto:webcrypto,localStorage:storage,
  WT_CONFIG:{supabase:{url:'https://project.example',anonKey:'public-fixture',auth:true},auth:{required:false}},
  setInterval:()=>0,clearInterval:()=>{},setTimeout:(fn,ms)=>setTimeout(fn,ms>=6000 ? 15 : ms),clearTimeout,
  CustomEvent:class {constructor(type,init){this.type=type;this.detail=init.detail;}},dispatchEvent:event=>events.push(event),
  fetch:async (url,options) => {
    if (stall) return new Promise(()=>{});
    trace.push({url,method:options.method,body:options.body,headers:options.headers});
    if (bodyStall) return {ok:true,status:200,json:()=>new Promise(()=>{})};
    if (url.includes('/auth/v1/token')) return reply({access_token:'fixture-token',refresh_token:'fixture-refresh',expires_in:3600,user:{id,email:'private@example.com',user_metadata:authMeta || {full_name:profile.display_name}}});
    if (url.endsWith('/wt_social_bootstrap')) return reply({profile:crossActor ? {...profile,user_id:other} : profile,counts:{friends:0,incoming:0,outgoing:0,unread:0}});
    if (url.endsWith('/wt_social_save_profile')) {
      if (failSave) return reply({code:'22023',message:'تعذّر حفظ الصورة'},400);
      profile = {...profile,...JSON.parse(options.body).p_patch}; return reply(profile);
    }
    if (url.includes('/storage/v1/object/')) return reply(options.method === 'DELETE' ? [] : {Key:'ok'});
    return reply({message:'fixture not implemented'},404);
  }
};
ctx.window=ctx;vm.createContext(ctx);
for (const file of ['util','auth','social','photo-editor']) vm.runInContext(source(file),ctx,{filename:file+'.js'});
const S = ctx.WTSocial, Auth = ctx.WTAuth;
let count = 0;
const check = (value,message) => {assert.ok(value,message);count++;};
await Auth.signIn('private@example.com','not-a-real-password');
const token = Auth.getSession().access_token;
await S.bootstrap();
check(Auth.currentUser().avatar_path === oldPath,'verified own profile is cached');
check(Auth.getSession().access_token === token,'profile caching never replaces authentication tokens');
check(events.some(e => e.type==='wt:profile'));
check(S.avatarURL(profile).endsWith('/'+oldPath));
for (const path of ['https://evil.example/avatar.svg',other+'/'+'a'.repeat(48)+'.webp',id+'/../a.webp',id+'/'+'a'.repeat(48)+'.svg']) check(S.avatarURL({...profile,avatar_path:path}) === '','external/traversal/foreign avatars are rejected');
for (const value of ['javascript:alert(1)','data:image/png;base64,AA','https://user:pass@example.com']) check(S.safeURL(value) === '');
check(S.safeURL('https://example.com/path?q=1') === 'https://example.com/path?q=1');
const valid = {...profile,display_name:'  أحمد   بن عمر  ',favorites:[' فيلم ',''],interests:['scifi']};
check(S.validateProfile(valid).display_name === 'أحمد بن عمر');
check(S.validateProfile(valid).favorites.length === 1);
for (const patch of [{username:'bad user'},{display_name:'ا'},{interests:Array(9).fill('scifi')},{interests:['__proto__']},{mood:'constructor'},{accent:'toString'},{website:'javascript:alert(1)'},{favorites:['x'.repeat(81)]}]) {
  assert.throws(()=>S.validateProfile({...valid,...patch}));count++;
}
storage['wt:session']=JSON.stringify({...Auth.getSession(),expires_at:Date.now()-1});
await Auth.validSession();
check(Auth.currentUser().avatar_path===oldPath,'avatar survives token refresh');
check(Auth.currentUser().username==='ahmed');
crossActor=true;await assert.rejects(()=>S.bootstrap(true),/استجابة حساب/);count++;crossActor=false;
check(Auth.currentUser().id===id,'cross-account response cannot overwrite our cache');
const blob = new Blob([Buffer.from('RIFF0000WEBP12345678')],{type:'image/webp'});
trace.length=0;failSave=true;
await assert.rejects(()=>S.uploadAvatar(blob),/تعذّر حفظ الصورة/);count++;
const uploaded=trace.find(t=>t.url.includes('/storage/') && t.method==='POST');
const cleanup=trace.find(t=>t.method==='DELETE');
check(!!uploaded && !!cleanup,'failed profile save cleans the new image');
check(JSON.parse(cleanup.body).prefixes[0] !== oldPath,'failed save never deletes the current image');
check(Auth.currentUser().avatar_path===oldPath);
trace.length=0;failSave=false;
const saved=await S.uploadAvatar(blob);
check(new RegExp('^'+id+'/[a-f0-9]{48}\\.webp$').test(saved.avatar_path),'fresh immutable upload filename');
const saveIndex=trace.findIndex(t=>t.url.endsWith('/wt_social_save_profile'));
check(trace.findIndex(t=>t.method==='DELETE')>saveIndex,'old image cleanup follows the database commit');
check(JSON.parse(trace.find(t=>t.method==='DELETE').body).prefixes[0]===oldPath);
await S.removeAvatar();check(Auth.currentUser().avatar_path===null);
await assert.rejects(()=>S.uploadAvatar(new Blob(['svg'],{type:'image/svg+xml'})));count++;
check(ctx.WTPhotoEditor.signature(new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]))==='png');
check(ctx.WTPhotoEditor.signature(new Uint8Array([255,216,255,0,0,0,0,0,0,0,0,0]))==='jpeg');
check(ctx.WTPhotoEditor.signature(new Uint8Array(Buffer.from('<svg onload="bad">'))) === '');
const abort = new AbortController();const request=S.call('threads',{},abort.signal);abort.abort();await assert.rejects(()=>request,e=>e.name==='AbortError');count++;
stall=true;await assert.rejects(()=>S.call('threads'),/مهلة/);count++;stall=false;
bodyStall=true;await assert.rejects(()=>S.call('threads'),/مهلة/);count++;bodyStall=false;
check(!!Auth.accountUser(),'timeouts never force logout');
storage['wt:dm-draft:'+id+':room']='private';storage['wt:dm-outbox:'+id+':room:nonce']='private';storage['wt:dm-draft:'+other+':room']='other';
Auth.clearSession();check(!storage['wt:dm-draft:'+id+':room'] && !storage['wt:dm-outbox:'+id+':room:nonce'],'logout clears own local private drafts');
check(storage['wt:dm-draft:'+other+':room']==='other','account-scoped cleanup');
const requestsBefore=trace.length;await assert.rejects(()=>S.call('threads'),e=>e.signIn);count++;check(trace.length===requestsBefore,'guest never sends a social RPC');
// Run the real draft/outbox helpers without their page event bindings.
let dialogOpen=false;const viewNodes={socialContent:{hidden:true},chatActive:{hidden:false},chatScroll:{clientHeight:320}};
ctx.WTSocialUI={$:name=>viewNodes[name]};ctx.document={visibilityState:'visible',querySelector:()=>dialogOpen};ctx.matchMedia=()=>({matches:false});
vm.runInContext(source('messages').split('  function time(value)')[0]+source('messages').split('\n').find(line=>line.startsWith('  function visibleChat'))+'globalThis.WTMessageDrafts={state,context,persistDraft,persistPending,visibleChat};})();',ctx,{filename:'messages-drafts.js'});
ctx.WTUtil.store.set('session',{user:{id,name:'أحمد'},access_token:'fixture-token'});
const drafts=ctx.WTMessageDrafts;drafts.state.uid=id;const chat=drafts.context(other);chat.draft.text='مسودة خاصة';
const pending={nonce:'a'.repeat(48),body:'إرسال معلّق'};
drafts.state.active=chat;check(!drafts.visibleChat(chat),'boot-hidden chat must not mark messages as read');viewNodes.socialContent.hidden=false;check(drafts.visibleChat(chat));dialogOpen=true;check(!drafts.visibleChat(chat),'a covering dialog suspends reading');dialogOpen=false;viewNodes.chatScroll.clientHeight=0;check(!drafts.visibleChat(chat),'zero-height chat must not acknowledge reading');
drafts.persistDraft(chat);drafts.persistPending(chat,pending);check(!!storage['wt:dm-draft:'+id+':'+other]);
Auth.clearSession();drafts.persistDraft(chat);drafts.persistPending(chat,pending);
check(!storage['wt:dm-draft:'+id+':'+other]&&!storage['wt:dm-outbox:'+id+':'+other+':'+pending.nonce],'pagehide and late replies cannot restore drafts after logout');
ctx.WTUtil.store.set('session',{user:{id:other,name:'ليلى'},access_token:'fixture-b'});drafts.state.uid=other;drafts.persistDraft(chat);drafts.persistPending(chat,pending);
check(!storage['wt:dm-draft:'+other+':'+other]&&!storage['wt:dm-outbox:'+other+':'+other+':'+pending.nonce],'an old context cannot write under a different account');Auth.clearSession();
authMeta={full_name:'أحمد',avatar_path:oldPath,wt_username:'ahmed'};
await Auth.signIn('private@example.com','not-a-real-password');
check(Auth.currentUser().avatar_path===oldPath,'a fresh login receives the server-saved portrait without an old local cache');
check(Auth.currentUser().username==='ahmed');
authMeta.avatar_path=other+'/'+'b'.repeat(48)+'.webp';
await Auth.signIn('private@example.com','not-a-real-password');check(Auth.currentUser().avatar_path===null,'foreign avatar metadata is rejected even from Auth');
Auth.clearSession();
const destination=source('auth-page').match(/  function destination\(\) \{[\s\S]*?\n  \}/)[0];
for(const [next,expected] of [['profile.html?edit=privacy','profile.html?edit=privacy'],['/app/messages.html?thread=x','messages.html?thread=x'],['friends.html','friends.html'],['https://evil.example/profile.html','index.html'],['//evil.example/room.html','index.html'],['profile.html.evil','index.html'],['auth.html','index.html'],['../profile.html','index.html'],['javascript:alert(1)','index.html']]) {
  const sandbox={URL,location:{href:'https://site.example/app/auth.html'},nextUrl:next,roomParam:null};vm.createContext(sandbox);
  assert.equal(vm.runInContext(destination+'; destination()',sandbox),expected);count++;
}
console.log(`Social client: ${count} checks passed (safe profiles/URLs, auth refresh/cache, account isolation, immutable avatars/rollback, phone signatures, deadlines/abort and safe login return paths)`);
