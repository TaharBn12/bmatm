/* Development-only PostgreSQL fixtures. Never included by any production HTML. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
export const A = '11111111-1111-4111-8111-111111111111';
export const B = '22222222-2222-4222-8222-222222222222';
export const C = '33333333-3333-4333-8333-333333333333';
export const migration = readFileSync(new URL('../../sql/07-social.sql', import.meta.url), 'utf8');
export async function fixtureDatabase(apply = true) {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',created_at timestamptz default now(),updated_at timestamptz default now());
    create publication supabase_realtime;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,owner uuid default auth.uid(),metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated;
    grant select,insert,delete on storage.objects to authenticated;
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name,'/') $$;
    insert into auth.users(id,email,raw_user_meta_data) values
    ('${A}','private-a@example.com','{"full_name":"أحمد"}'),('${B}','private-b@example.com','{"full_name":"مريم"}'),('${C}','private-c@example.com','{"full_name":"سليم"}');
  `);
  // The real room migration is the baseline too: no hand-written replacement schema.
  await db.exec(readFileSync(new URL('../../sql/01-bootstrap.sql',import.meta.url),'utf8'));
  await db.exec("insert into public.rooms(room_id,title) values('ROOM01','سهرة أصلية')");
  const as = async (user, sql, params = []) => db.transaction(async tx => {
    await tx.exec('set local role ' + (user ? 'authenticated' : 'anon'));
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [user || '']);
    return tx.query(sql,params);
  });
  const call = async (user,name,args = {}) => {
    if (!/^wt_social_[a-z_]+$/.test(name) || Object.keys(args).some(key => !/^p_[a-z_]+$/.test(key))) throw new Error('Invalid test RPC');
    const keys = Object.keys(args);
    const result = await as(user,'select public.' + name + '(' + keys.map((key,i) => key + ' => $' + (i+1)).join(',') + ') as result',keys.map(k => typeof args[k] === 'object' && args[k] !== null ? JSON.stringify(args[k]) : args[k]));
    return result.rows[0].result;
  };
  if (apply) await db.exec(migration);
  return {db,as,call};
}
