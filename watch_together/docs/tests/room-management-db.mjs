/* Real PostgreSQL regression coverage for private rooms and account-bound management RPCs. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixtureDatabase, A, B } from './social/fixture-db.mjs';

const { db, as } = await fixtureDatabase(false);
const migration = readFileSync(new URL('../sql/04-room-management.sql', import.meta.url), 'utf8');
let checks = 0;
const rpc = async (user, name, args = {}) => {
  assert.match(name, /^wt_[a-z_]+$/);
  const keys = Object.keys(args);
  const params = keys.map(key => {
    const value = args[key];
    return value && typeof value === 'object' ? JSON.stringify(value) : value;
  });
  const result = await as(user,
    'select public.' + name + '(' + keys.map((key, index) => key + ' => $' + (index + 1)).join(',') + ') as result', params);
  return result.rows[0].result;
};
const denied = async (fn, code = '42501') => {
  await assert.rejects(fn, error => error.code === code, 'expected SQLSTATE ' + code);
  checks++;
};
const count = async (table, roomId) => (await db.query(
  `select count(*)::int as count from public.${table} where room_id = $1`, [roomId])).rows[0].count;

try {
  await db.exec(migration);
  checks++;
  const roomId = 'PRIV01';
  const ownerToken = 'a'.repeat(64);
  const memberToken = 'b'.repeat(64);
  await rpc(A, 'wt_create_room', {
    p_room_id: roomId, p_title: 'غرفة خاصة', p_video_url: 'https://media.example/start.mp4',
    p_owner_token: ownerToken, p_owner_name: 'أمين'
  });
  await rpc(A, 'wt_update_room', {
    p_room_id: roomId, p_owner_token: ownerToken, p_title: null, p_video_url: null,
    p_is_private: true, p_control_mode: 'owner'
  });
  const owned = await rpc(A, 'wt_get_owned_room', { p_room_id: roomId, p_owner_token: ownerToken });
  assert.equal(owned.is_private, true);
  assert.equal(owned.control_mode, 'owner');
  checks += 2;
  await denied(() => rpc(B, 'wt_get_owned_room', { p_room_id: roomId, p_owner_token: ownerToken }));
  await denied(() => rpc(null, 'wt_get_owned_room', { p_room_id: roomId, p_owner_token: ownerToken }));
  const publicRows = await as(null, 'select room_id from public.rooms order by room_id');
  assert.ok(!publicRows.rows.some(row => row.room_id === roomId), 'private room is absent from the public catalogue');
  assert.ok(publicRows.rows.some(row => row.room_id === 'ROOM01'), 'public rooms remain listed');
  checks += 2;
  await denied(() => as(null, 'select * from public.room_reports'));

  const joined = await rpc(null, 'wt_join_room', {
    p_room_id: roomId, p_client_id: 'viewer-client', p_member_token: memberToken, p_display_name: 'مشاهد'
  });
  assert.equal(joined.role, 'viewer');
  const snapshot = await rpc(null, 'wt_room_snapshot', {
    p_room_id: roomId, p_client_id: 'viewer-client', p_member_token: memberToken
  });
  assert.equal(snapshot.is_private, true, 'a valid member token can snapshot a private invite room');
  checks += 2;
  await denied(() => rpc(null, 'wt_apply_room_state', {
    p_room_id: roomId, p_client_id: 'viewer-client', p_member_token: memberToken,
    p_state: { url: 'https://media.example/forbidden.mp4', playing: true, pos: 0 }
  }));
  await rpc(A, 'wt_update_room', {
    p_room_id: roomId, p_owner_token: ownerToken, p_title: null, p_video_url: null,
    p_is_private: true, p_control_mode: 'everyone'
  });
  const accepted = await rpc(null, 'wt_apply_room_state', {
    p_room_id: roomId, p_client_id: 'viewer-client', p_member_token: memberToken,
    p_state: { url: 'https://media.example/allowed.mp4', playing: true, pos: 15 }
  });
  assert.equal(accepted.url, 'https://media.example/allowed.mp4');
  assert.equal(accepted.updatedBy, 'viewer-client');
  checks += 2;

  assert.deepEqual(await rpc(B, 'wt_report_room', {
    p_room_id: roomId, p_reason: 'spam', p_details: 'رابط مضلل'
  }), { ok: true });
  await denied(() => rpc(A, 'wt_report_room', { p_room_id: roomId, p_reason: 'other', p_details: '' }));
  await denied(() => rpc(B, 'wt_report_room', { p_room_id: roomId, p_reason: 'not-a-reason', p_details: '' }), '22023');
  assert.equal(await count('room_reports', roomId), 1);
  checks++;

  // The final delete removes messages, presence, queue, membership secrets and reports.
  await db.exec(`
    insert into public.messages(room_id,name,body) values('${roomId}','مشارك','رسالة');
    insert into public.presence(room_id,client_id,name) values('${roomId}','viewer-client','مشاهد');
    insert into public.room_queue(room_id,url,title,added_by_client) values('${roomId}','https://media.example/q.mp4','عنصر','viewer-client');
  `);
  await denied(() => rpc(B, 'wt_delete_room', { p_room_id: roomId, p_owner_token: ownerToken }));
  assert.deepEqual(await rpc(A, 'wt_delete_room', { p_room_id: roomId, p_owner_token: ownerToken }), { ok: true, deleted: true });
  for (const table of ['messages', 'presence', 'room_members', 'room_queue', 'room_reports']) {
    assert.equal(await count(table, roomId), 0, table + ' is permanently removed');
    checks++;
  }
  assert.equal((await db.query('select count(*)::int as count from public.rooms where room_id=$1', [roomId])).rows[0].count, 0);
  assert.equal((await db.query('select count(*)::int as count from wt_private.room_secrets where room_id=$1', [roomId])).rows[0].count, 0);
  checks += 2;

  await db.exec(migration);
  checks++;
  console.log(`Room management PostgreSQL: ${checks} checks passed (private listing, creator-bound settings/deletion, invite snapshot, control modes, private reports, cascade cleanup and repeatable migration)`);
} finally {
  await db.close();
}
