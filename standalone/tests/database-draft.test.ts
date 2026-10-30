import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sha256Bytes } from '../src/contracts/canonical.ts';

const ddl = readFileSync(new URL('../contracts/database/001-initial.sql', import.meta.url), 'utf8');
function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(ddl);
  for (const companion of ['a', 'b']) {
    db.prepare('INSERT INTO companions VALUES(?,?,?,NULL)').run(companion, 'Asia/Shanghai', `fixture:${companion}`);
    db.prepare('INSERT INTO actors VALUES(?,?,?,?)').run(`user-${companion}`, companion, 'user', '合成用户');
    db.prepare('INSERT INTO actors VALUES(?,?,?,?)').run(`character-${companion}`, companion, 'character', '合成角色');
    db.prepare('INSERT INTO sources VALUES(?,?,?,?,?)').run(`source-${companion}`, companion, 'live_conversation', `external-${companion}`, '{}');
    db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run(`conversation-${companion}`, companion, `source-${companion}`, 'external-conversation');
    db.prepare('INSERT INTO branches VALUES(?,?,?,NULL,NULL,1,0,0)').run('main', companion, `conversation-${companion}`);
    object(db, `object-${companion}`, companion);
  }
  return db;
}
function object(db: DatabaseSync, id: string, companion = 'a', text = 'x'): void {
  const bytes = Buffer.from(text, 'utf8');
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO content_objects VALUES(?,?,?,?)').run(id, companion, sha256Bytes(bytes), bytes.length);
    db.prepare('INSERT INTO object_locations VALUES(?,?,?,NULL,NULL)').run(companion, id, bytes);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function memory(db: DatabaseSync, id: string, companion = 'a', kind = 'episode'): void {
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO memory_records VALUES(?,?,?,1,0,?,?,?,?)').run(id, companion, kind, 'active', 'published', '2026-10-30T00:00:00Z', '2026-10-30T00:00:00Z');
    db.prepare('INSERT INTO memory_revisions VALUES(?,?,?,?,?,?,?)').run(`revision-${id}-1`, companion, id, 1, `object-${companion}`, '合成初始版本', '2026-10-30T00:00:00Z');
    if (kind === 'episode') db.prepare('INSERT INTO episodes VALUES(?,?,?, ?,?,?,?,NULL)').run(companion, id, 'episode', '合成经历', '{"precision":"unknown"}', 'closed', 'hot');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function turn(db: DatabaseSync): void {
  db.prepare('INSERT INTO turns VALUES(?,?,?,?,?)').run('turn-a', 'a', 'conversation-a', 'main', 1);
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run('message-a', 'a', 'turn-a', 'user-a', 0, 'user');
  db.prepare('INSERT INTO turn_versions VALUES(?,?,?,?,?,?,?)').run('turn-version-a', 'a', 'message-a', 1, 'object-a', 'complete', '2026-10-30T00:00:00Z');
}

test('the entire DDL draft compiles with foreign keys enabled in an ephemeral database', () => {
  const db = database();
  try {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
    memory(db, 'memory-a');
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_revisions').get()!.n, 1);
  } finally { db.close(); }
});

test('composite keys reject cross-companion sources, actors and scoped episodes', () => {
  const db = database();
  try {
    assert.throws(() => db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run('cross', 'a', 'source-b', 'x'));
    assert.throws(() => db.prepare('INSERT INTO source_actor_aliases VALUES(?,?,?,?)').run('a', 'source-a', '我', 'character-b'));
    memory(db, 'episode-a'); memory(db, 'episode-b', 'b'); memory(db, 'need-a', 'a', 'response_need');
    assert.throws(() => db.prepare('INSERT INTO response_needs VALUES(?,?,?,?,?,?,?)').run('a','need-a','response_need','episode','episode-b',null,'先听我说'));
  } finally { db.close(); }
});

test('branch ancestry, turn sequence and message positions remain stable', () => {
  const db = database();
  try {
    db.prepare('INSERT INTO branches VALUES(?,?,?,?,?,1,0,0)').run('child', 'a', 'conversation-a', 'main', 0);
    assert.throws(() => db.prepare('UPDATE branches SET parent_branch_id=? WHERE id=?').run('child', 'main'));
    assert.throws(() => db.prepare('INSERT INTO branches VALUES(?,?,?,?,?,1,0,0)').run('self', 'a', 'conversation-a', 'self', 0));
    turn(db);
    assert.throws(() => db.prepare('INSERT INTO turns VALUES(?,?,?,?,?)').run('another', 'a', 'conversation-a', 'main', 1));
    assert.throws(() => db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run('duplicate-position', 'a', 'turn-a', 'user-a', 0, 'user'));
    assert.throws(() => db.prepare('UPDATE messages SET position=1 WHERE id=?').run('message-a'));
    assert.throws(() => db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run('wrong-actor', 'a', 'turn-a', 'character-a', 1, 'user'));
  } finally { db.close(); }
});

test('immutable message versions cannot be overwritten or pointed at another logical message', () => {
  const db = database();
  try {
    turn(db);
    assert.throws(() => db.prepare('UPDATE turn_versions SET status=? WHERE id=?').run('interrupted', 'turn-version-a'));
    assert.throws(() => db.prepare('INSERT INTO turn_versions VALUES(?,?,?,?,?,?,?)').run('duplicate', 'a', 'message-a', 1, 'object-a', 'complete', '2026-10-30T00:00:00Z'));
    db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run('assistant-a', 'a', 'turn-a', 'character-a', 1, 'assistant');
    assert.throws(() => db.prepare('INSERT INTO branch_messages VALUES(?,?,?,?,?,1)').run('a','conversation-a','main','assistant-a','turn-version-a'));
  } finally { db.close(); }
});

test('source identity persists across hashes and suppression is not keyed by hash', () => {
  const db = database();
  try {
    memory(db, 'memory-a');
    object(db,'source-object-a','a','first source'); object(db,'source-object-b','a','changed source');
    db.prepare('INSERT INTO source_items VALUES(?,?,?,?,1,?)').run('item-a','a','source-a','legacy-id','corrected');
    const firstHash = sha256Bytes(Buffer.from('first source')); const secondHash = sha256Bytes(Buffer.from('changed source'));
    db.prepare('INSERT INTO source_records VALUES(?,?,?,?,?,?,?)').run('record-a1','a','item-a',1,'source-object-a',firstHash,'active');
    db.prepare('INSERT INTO source_records VALUES(?,?,?,?,?,?,?)').run('record-a2','a','item-a',2,'source-object-b',secondHash,'active');
    db.prepare('INSERT INTO source_suppressions VALUES(?,?,?,?,?)').run('a','item-a','memory-a','corrected',1);
    assert.throws(() => db.prepare('INSERT INTO source_records VALUES(?,?,?,?,?,?,?)').run('duplicate','a','item-a',3,'source-object-a',firstHash,'active'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM source_suppressions WHERE source_item_id=?').get('item-a')!.n, 1);
    assert.throws(() => db.prepare('UPDATE source_records SET content_hash=? WHERE id=?').run('c'.repeat(64),'record-a1'));
    assert.throws(() => db.prepare('UPDATE source_items SET status=?,suppression_generation=0 WHERE id=?').run('active','item-a'));
  } finally { db.close(); }
});

test('revision rows are append-only and retraction cannot be silently reversed', () => {
  const db = database();
  try {
    memory(db, 'memory-a');
    assert.throws(() => db.prepare('UPDATE memory_revisions SET reason=? WHERE memory_id=?').run('改写历史','memory-a'));
    db.exec('BEGIN');
    db.prepare('INSERT INTO memory_revisions VALUES(?,?,?,?,?,?,?)').run('revision-memory-a-2','a','memory-a',2,'object-a','撤回','2026-10-30T01:00:00Z');
    db.prepare('UPDATE memory_records SET version=2,suppression_generation=1,content_status=? WHERE id=? AND version=1').run('retracted','memory-a');
    db.exec('COMMIT');
    assert.throws(() => db.prepare('UPDATE memory_records SET version=3,content_status=? WHERE id=?').run('active','memory-a'));
    assert.throws(() => db.prepare('UPDATE memory_records SET version=3,suppression_generation=0 WHERE id=?').run('memory-a'));
    assert.equal(db.prepare('UPDATE memory_records SET version=2 WHERE id=? AND version=1').run('memory-a').changes, 0);
  } finally { db.close(); }
});

test('atomic patch-set failure rolls back every target and revision', () => {
  const db = database();
  try {
    memory(db,'memory-a'); memory(db,'memory-b','b');
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO memory_revisions VALUES(?,?,?,?,?,?,?)').run('revision-a-2','a','memory-a',2,'object-a','候选修订','2026-10-30T01:00:00Z');
      db.prepare('UPDATE memory_records SET version=2 WHERE id=? AND version=1').run('memory-a');
      db.prepare('INSERT INTO memory_links VALUES(?,?,?,?)').run('a','memory-a','memory-b','correction');
      assert.fail('Expected cross-companion failure');
    } catch { db.exec('ROLLBACK'); }
    assert.equal(db.prepare('SELECT version FROM memory_records WHERE id=?').get('memory-a')!.version,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_revisions WHERE version=2').get()!.n,0);
  } finally { db.close(); }
});

test('physical content can move to a ready archive without changing evidence identity', () => {
  const db = database();
  try {
    turn(db); memory(db,'memory-a'); object(db,'manifest-a','a','{}');
    db.prepare('INSERT INTO archives VALUES(?,?,?,?,?,?,?,?,?)').run('archive-a','a','fish-archive-v1','manifest-a','a'.repeat(64),'objects/archive-a',5,1,'prepared');
    db.prepare('INSERT INTO archive_members VALUES(?,?,?,?,?,?,?,?)').run('a','archive-a','member-a','object-a',0,5,sha256Bytes(Buffer.from('x')),1);
    assert.throws(() => db.prepare('UPDATE object_locations SET inline_bytes=NULL,archive_id=?,member_id=? WHERE object_id=?').run('archive-a','member-a','object-a'));
    db.prepare('UPDATE archives SET status=? WHERE id=?').run('ready','archive-a');
    db.prepare('UPDATE object_locations SET inline_bytes=NULL,archive_id=?,member_id=? WHERE object_id=?').run('archive-a','member-a','object-a');
    assert.equal(db.prepare('SELECT content_object_id FROM turn_versions WHERE id=?').get('turn-version-a')!.content_object_id,'object-a');
    assert.equal(db.prepare('SELECT byte_length FROM content_objects WHERE id=?').get('object-a')!.byte_length,1);
    assert.throws(() => db.prepare('UPDATE archives SET payload_sha256=? WHERE id=?').run('b'.repeat(64),'archive-a'));
    assert.throws(() => db.prepare('DELETE FROM archive_members WHERE member_id=?').run('member-a'));
    assert.throws(() => db.prepare('INSERT INTO archive_members VALUES(?,?,?,?,?,?,?,?)').run('a','archive-a','member-b','object-a',5,5,sha256Bytes(Buffer.from('x')),1));
  } finally { db.close(); }
});

test('idempotency keys are unique per credential and tool, independently of request arrival order', () => {
  const db = database();
  try {
    db.prepare('INSERT INTO credentials VALUES(?,?,?,?,1)').run('credential-a','a','c'.repeat(64),'observe');
    db.prepare('INSERT INTO write_requests VALUES(?,?,?,?,?,?)').run('a','credential-a','observe_turn','request-a','a'.repeat(64),'{}');
    assert.throws(() => db.prepare('INSERT INTO write_requests VALUES(?,?,?,?,?,?)').run('a','credential-a','observe_turn','request-a','b'.repeat(64),'{}'));
  } finally { db.close(); }
});

test('content always has a location and its only location cannot be deleted', () => {
  const db = database();
  try {
    assert.throws(() => db.prepare('DELETE FROM object_locations WHERE object_id=?').run('object-a'));
    assert.throws(() => db.prepare('INSERT INTO content_objects VALUES(?,?,?,?)').run('orphan-content','a','a'.repeat(64),1));
    assert.throws(() => db.prepare('UPDATE object_locations SET inline_bytes=? WHERE object_id=?').run(Buffer.from('wrong length'),'object-a'));
  } finally { db.close(); }
});

test('branch forks require an existing parent and non-null cutoff even in multi-row inserts', () => {
  const db = database();
  try {
    assert.throws(() => db.prepare('INSERT INTO branches VALUES(?,?,?,?,?,1,0,0)').run('no-cutoff','a','conversation-a','main',null));
    assert.throws(() => db.exec("INSERT INTO branches VALUES('cycle-x','a','conversation-a','cycle-y',0,1,0,0),('cycle-y','a','conversation-a','cycle-x',0,1,0,0)"));
  } finally { db.close(); }
});

test('actor kind and conversation membership cannot be changed behind existing messages', () => {
  const db = database();
  try {
    turn(db);
    assert.throws(() => db.prepare('UPDATE actors SET kind=? WHERE id=?').run('historical_ai','user-a'));
    db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run('conversation-a2','a','source-a','another-external');
    db.prepare('INSERT INTO branches VALUES(?,?,?,NULL,NULL,1,0,0)').run('main','a','conversation-a2');
    assert.throws(() => db.prepare('INSERT INTO branch_messages VALUES(?,?,?,?,?,1)').run('a','conversation-a2','main','message-a','turn-version-a'));
  } finally { db.close(); }
});

test('archive hash syntax matches the manifest contract', () => {
  const db = database();
  try {
    object(db,'manifest-a','a','{}');
    assert.throws(() => db.prepare('INSERT INTO archives VALUES(?,?,?,?,?,?,?,?,?)').run('archive-invalid','a','fish-archive-v1','manifest-a','z'.repeat(64),'objects/invalid',5,1,'prepared'));
  } finally { db.close(); }
});
