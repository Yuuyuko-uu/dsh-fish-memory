-- Contract draft v1. Validated only against an in-memory database in phase 1.
-- No migration runner, production connection, PRAGMA WAL or filesystem writes.
PRAGMA foreign_keys = ON;

CREATE TABLE companions (
  id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL,
  persona_reference TEXT NOT NULL,
  persona_sha256 TEXT CHECK (persona_sha256 IS NULL OR (length(persona_sha256)=64 AND persona_sha256 NOT GLOB '*[^a-f0-9]*'))
) STRICT;
CREATE TABLE actors (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL REFERENCES companions(id),
  kind TEXT NOT NULL CHECK (kind IN ('user','character','historical_ai','third_party','unknown')),
  display_name TEXT NOT NULL, UNIQUE(companion_id,id)
) STRICT;
CREATE UNIQUE INDEX one_user ON actors(companion_id) WHERE kind='user';
CREATE UNIQUE INDEX one_character ON actors(companion_id) WHERE kind='character';
CREATE TRIGGER actor_identity_immutable BEFORE UPDATE ON actors
WHEN NEW.id<>OLD.id OR NEW.companion_id<>OLD.companion_id OR NEW.kind<>OLD.kind
BEGIN SELECT RAISE(ABORT,'actor identity and kind are immutable'); END;
CREATE TABLE sources (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL REFERENCES companions(id),
  kind TEXT NOT NULL CHECK (kind IN ('live_conversation','dsh_import','manual')),
  external_key TEXT NOT NULL, identity_map_json TEXT NOT NULL CHECK(json_valid(identity_map_json)),
  UNIQUE(companion_id,id), UNIQUE(companion_id,kind,external_key)
) STRICT;
CREATE TABLE source_actor_aliases (
  companion_id TEXT NOT NULL, source_id TEXT NOT NULL, alias TEXT NOT NULL, actor_id TEXT NOT NULL,
  PRIMARY KEY(companion_id,source_id,alias,actor_id),
  FOREIGN KEY(companion_id,source_id) REFERENCES sources(companion_id,id),
  FOREIGN KEY(companion_id,actor_id) REFERENCES actors(companion_id,id)
) STRICT;
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
  UNIQUE(companion_id,id), UNIQUE(source_id,external_id),
  FOREIGN KEY(companion_id,source_id) REFERENCES sources(companion_id,id)
) STRICT;
CREATE TABLE branches (
  id TEXT NOT NULL, companion_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  parent_branch_id TEXT, fork_sequence INTEGER,
  chain_revision INTEGER NOT NULL CHECK(chain_revision>=1),
  accepted_through INTEGER NOT NULL DEFAULT 0 CHECK(accepted_through>=0),
  processed_through INTEGER NOT NULL DEFAULT 0 CHECK(processed_through BETWEEN 0 AND accepted_through),
  PRIMARY KEY(companion_id,conversation_id,id),
  CHECK(parent_branch_id IS NULL OR parent_branch_id<>id),
  CHECK((parent_branch_id IS NULL AND fork_sequence IS NULL) OR (parent_branch_id IS NOT NULL AND fork_sequence IS NOT NULL AND fork_sequence>=0)),
  FOREIGN KEY(companion_id,conversation_id) REFERENCES conversations(companion_id,id),
  FOREIGN KEY(companion_id,conversation_id,parent_branch_id) REFERENCES branches(companion_id,conversation_id,id)
) STRICT;
CREATE TRIGGER branch_parent_immutable BEFORE UPDATE OF companion_id,conversation_id,id,parent_branch_id,fork_sequence ON branches
BEGIN SELECT RAISE(ABORT,'branch ancestry is immutable'); END;
CREATE TRIGGER branch_parent_exists BEFORE INSERT ON branches WHEN NEW.parent_branch_id IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM branches WHERE companion_id=NEW.companion_id AND conversation_id=NEW.conversation_id AND id=NEW.parent_branch_id)
BEGIN SELECT RAISE(ABORT,'branch parent must already exist'); END;
-- Parent must already exist and ancestry is immutable, so a cycle cannot be introduced.
CREATE TABLE turns (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, conversation_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=1),
  UNIQUE(companion_id,id), UNIQUE(companion_id,conversation_id,branch_id,sequence),
  FOREIGN KEY(companion_id,conversation_id,branch_id) REFERENCES branches(companion_id,conversation_id,id)
) STRICT;
CREATE TRIGGER turn_identity_immutable BEFORE UPDATE ON turns
BEGIN SELECT RAISE(ABORT,'turn identity and sequence are immutable'); END;
CREATE TABLE messages (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>=0),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  UNIQUE(companion_id,id), UNIQUE(turn_id,position),
  FOREIGN KEY(companion_id,turn_id) REFERENCES turns(companion_id,id),
  FOREIGN KEY(companion_id,actor_id) REFERENCES actors(companion_id,id)
) STRICT;
CREATE TRIGGER message_role_actor BEFORE INSERT ON messages
WHEN (SELECT kind FROM actors WHERE companion_id=NEW.companion_id AND id=NEW.actor_id)
  <> CASE NEW.role WHEN 'user' THEN 'user' ELSE 'character' END
BEGIN SELECT RAISE(ABORT,'message role does not match actor'); END;
CREATE TRIGGER message_identity_immutable BEFORE UPDATE ON messages
BEGIN SELECT RAISE(ABORT,'logical message identity is immutable'); END;

-- Immutable logical content; physical location can change without editing evidence.
CREATE TABLE content_objects (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL REFERENCES companions(id),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  byte_length INTEGER NOT NULL CHECK(byte_length>0),
  UNIQUE(companion_id,id), UNIQUE(companion_id,id,sha256), UNIQUE(companion_id,id,sha256,byte_length),
  FOREIGN KEY(companion_id,id) REFERENCES object_locations(companion_id,object_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE object_locations (
  companion_id TEXT NOT NULL, object_id TEXT NOT NULL,
  inline_bytes BLOB, archive_id TEXT, member_id TEXT,
  PRIMARY KEY(companion_id,object_id),
  CHECK((inline_bytes IS NOT NULL AND archive_id IS NULL AND member_id IS NULL)
     OR (inline_bytes IS NULL AND archive_id IS NOT NULL AND member_id IS NOT NULL)),
  FOREIGN KEY(companion_id,object_id) REFERENCES content_objects(companion_id,id),
  FOREIGN KEY(companion_id,archive_id,member_id,object_id) REFERENCES archive_members(companion_id,archive_id,member_id,object_id)
) STRICT;
CREATE TABLE turn_versions (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, message_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1), content_object_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete','interrupted')), captured_at TEXT NOT NULL,
  UNIQUE(companion_id,id), UNIQUE(message_id,revision),
  FOREIGN KEY(companion_id,message_id) REFERENCES messages(companion_id,id),
  FOREIGN KEY(companion_id,content_object_id) REFERENCES content_objects(companion_id,id)
) STRICT;
CREATE TABLE branch_messages (
  companion_id TEXT NOT NULL, conversation_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  message_id TEXT NOT NULL, turn_version_id TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
  PRIMARY KEY(companion_id,conversation_id,branch_id,message_id),
  FOREIGN KEY(companion_id,conversation_id,branch_id) REFERENCES branches(companion_id,conversation_id,id),
  FOREIGN KEY(companion_id,message_id) REFERENCES messages(companion_id,id),
  FOREIGN KEY(companion_id,turn_version_id) REFERENCES turn_versions(companion_id,id)
) STRICT;
CREATE TRIGGER branch_message_matches BEFORE INSERT ON branch_messages
WHEN NOT EXISTS(SELECT 1 FROM turn_versions v JOIN messages m ON m.id=v.message_id JOIN turns t ON t.id=m.turn_id
  WHERE v.companion_id=NEW.companion_id AND v.id=NEW.turn_version_id AND v.message_id=NEW.message_id AND t.conversation_id=NEW.conversation_id)
BEGIN SELECT RAISE(ABORT,'active version does not belong to message'); END;
CREATE TRIGGER branch_message_update_matches BEFORE UPDATE ON branch_messages
WHEN NOT EXISTS(SELECT 1 FROM turn_versions v JOIN messages m ON m.id=v.message_id JOIN turns t ON t.id=m.turn_id
  WHERE v.companion_id=NEW.companion_id AND v.id=NEW.turn_version_id AND v.message_id=NEW.message_id AND t.conversation_id=NEW.conversation_id)
BEGIN SELECT RAISE(ABORT,'active version does not belong to message'); END;

CREATE TABLE source_items (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
  suppression_generation INTEGER NOT NULL DEFAULT 0 CHECK(suppression_generation>=0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suppressed','corrected')),
  UNIQUE(companion_id,id), UNIQUE(source_id,external_id),
  FOREIGN KEY(companion_id,source_id) REFERENCES sources(companion_id,id)
) STRICT;
CREATE TRIGGER source_item_guard BEFORE UPDATE ON source_items
WHEN NEW.id<>OLD.id OR NEW.companion_id<>OLD.companion_id OR NEW.source_id<>OLD.source_id OR NEW.external_id<>OLD.external_id
  OR NEW.suppression_generation<OLD.suppression_generation OR (OLD.status<>'active' AND NEW.status='active')
BEGIN SELECT RAISE(ABORT,'source identity or suppression cannot be reset'); END;
CREATE TABLE source_records (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, source_item_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision>=1),
  content_object_id TEXT NOT NULL, content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  original_status TEXT NOT NULL CHECK(original_status IN ('active','deleted','superseded','unknown')),
  UNIQUE(companion_id,id), UNIQUE(source_item_id,content_hash), UNIQUE(source_item_id,source_revision),
  FOREIGN KEY(companion_id,source_item_id) REFERENCES source_items(companion_id,id),
  FOREIGN KEY(companion_id,content_object_id,content_hash) REFERENCES content_objects(companion_id,id,sha256)
) STRICT;

CREATE TABLE memory_records (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL REFERENCES companions(id),
  kind TEXT NOT NULL CHECK(kind IN ('episode','communication_pattern','response_need')),
  version INTEGER NOT NULL CHECK(version>=1),
  suppression_generation INTEGER NOT NULL DEFAULT 0 CHECK(suppression_generation>=0),
  content_status TEXT NOT NULL CHECK(content_status IN ('active','disputed','retracted')),
  publication_status TEXT NOT NULL CHECK(publication_status IN ('staged','published')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(companion_id,id), UNIQUE(companion_id,id,kind),
  FOREIGN KEY(companion_id,id,version) REFERENCES memory_revisions(companion_id,memory_id,version) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE memory_revisions (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, memory_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>=1), content_object_id TEXT NOT NULL,
  reason TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(companion_id,id), UNIQUE(companion_id,memory_id,version),
  FOREIGN KEY(companion_id,memory_id) REFERENCES memory_records(companion_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(companion_id,content_object_id) REFERENCES content_objects(companion_id,id)
) STRICT;
CREATE TRIGGER record_version_guard BEFORE UPDATE ON memory_records
WHEN NEW.id<>OLD.id OR NEW.companion_id<>OLD.companion_id OR NEW.kind<>OLD.kind OR NEW.created_at<>OLD.created_at
  OR NEW.version<>OLD.version+1 OR NEW.suppression_generation<OLD.suppression_generation
  OR (OLD.content_status='retracted' AND NEW.content_status<>'retracted')
  OR (NEW.content_status='retracted' AND OLD.content_status<>'retracted' AND NEW.suppression_generation<>OLD.suppression_generation+1)
BEGIN SELECT RAISE(ABORT,'invalid record identity revision or suppression'); END;
CREATE TABLE episodes (
  companion_id TEXT NOT NULL, memory_id TEXT PRIMARY KEY,
  record_kind TEXT NOT NULL DEFAULT 'episode' CHECK(record_kind='episode'),
  summary TEXT NOT NULL, occurred_json TEXT NOT NULL CHECK(json_valid(occurred_json)),
  topic_status TEXT NOT NULL CHECK(topic_status IN ('ongoing','paused','closed')),
  storage_tier TEXT NOT NULL CHECK(storage_tier IN ('hot','warm','cold')),
  last_effective_mention_at TEXT,
  UNIQUE(companion_id,memory_id),
  FOREIGN KEY(companion_id,memory_id,record_kind) REFERENCES memory_records(companion_id,id,kind)
) STRICT;
CREATE TABLE episode_participants (
  companion_id TEXT NOT NULL, memory_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  PRIMARY KEY(companion_id,memory_id,actor_id),
  FOREIGN KEY(companion_id,memory_id) REFERENCES episodes(companion_id,memory_id),
  FOREIGN KEY(companion_id,actor_id) REFERENCES actors(companion_id,id)
) STRICT;
CREATE TABLE communication_patterns (
  companion_id TEXT NOT NULL, memory_id TEXT PRIMARY KEY,
  record_kind TEXT NOT NULL DEFAULT 'communication_pattern' CHECK(record_kind='communication_pattern'),
  pattern_kind TEXT NOT NULL CHECK(pattern_kind IN ('explicit_preference','observed_pattern')),
  scope_kind TEXT NOT NULL DEFAULT 'companion' CHECK(scope_kind='companion'),
  content TEXT NOT NULL, conditions_json TEXT NOT NULL CHECK(json_valid(conditions_json)),
  UNIQUE(companion_id,memory_id),
  FOREIGN KEY(companion_id,memory_id,record_kind) REFERENCES memory_records(companion_id,id,kind)
) STRICT;
CREATE TABLE response_needs (
  companion_id TEXT NOT NULL, memory_id TEXT PRIMARY KEY,
  record_kind TEXT NOT NULL DEFAULT 'response_need' CHECK(record_kind='response_need'),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('episode','conversation')),
  scope_episode_id TEXT, scope_conversation_id TEXT, content TEXT NOT NULL,
  CHECK((scope_kind='episode' AND scope_episode_id IS NOT NULL AND scope_conversation_id IS NULL)
     OR (scope_kind='conversation' AND scope_conversation_id IS NOT NULL AND scope_episode_id IS NULL)),
  FOREIGN KEY(companion_id,memory_id,record_kind) REFERENCES memory_records(companion_id,id,kind),
  FOREIGN KEY(companion_id,scope_episode_id) REFERENCES episodes(companion_id,memory_id),
  FOREIGN KEY(companion_id,scope_conversation_id) REFERENCES conversations(companion_id,id)
) STRICT;
CREATE TABLE interpretations (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, memory_revision_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('emotion','intent','response_need')),
  label TEXT NOT NULL, basis_kind TEXT NOT NULL CHECK(basis_kind IN ('user_explicit','context_inferred','legacy_summary','assistant_suggested','unknown')),
  status TEXT NOT NULL CHECK(status IN ('tentative','supported','user_confirmed','corrected')),
  felt_time_json TEXT NOT NULL CHECK(json_valid(felt_time_json)),
  expressed_version_id TEXT, superseded_by TEXT,
  CHECK(status<>'user_confirmed' OR basis_kind='user_explicit'),
  CHECK((status='corrected')=(superseded_by IS NOT NULL)),
  UNIQUE(companion_id,id),
  FOREIGN KEY(companion_id,memory_revision_id) REFERENCES memory_revisions(companion_id,id),
  FOREIGN KEY(companion_id,actor_id) REFERENCES actors(companion_id,id),
  FOREIGN KEY(companion_id,expressed_version_id) REFERENCES turn_versions(companion_id,id),
  FOREIGN KEY(companion_id,superseded_by) REFERENCES interpretations(companion_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE evidence (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, memory_revision_id TEXT NOT NULL,
  speaker_actor_id TEXT NOT NULL, turn_version_id TEXT, source_record_id TEXT,
  quote TEXT NOT NULL, start_codepoint INTEGER NOT NULL CHECK(start_codepoint>=0),
  end_codepoint INTEGER NOT NULL CHECK(end_codepoint>start_codepoint),
  CHECK((turn_version_id IS NOT NULL)+(source_record_id IS NOT NULL)=1),
  UNIQUE(companion_id,id),
  FOREIGN KEY(companion_id,memory_revision_id) REFERENCES memory_revisions(companion_id,id),
  FOREIGN KEY(companion_id,speaker_actor_id) REFERENCES actors(companion_id,id),
  FOREIGN KEY(companion_id,turn_version_id) REFERENCES turn_versions(companion_id,id),
  FOREIGN KEY(companion_id,source_record_id) REFERENCES source_records(companion_id,id)
) STRICT;
CREATE TABLE memory_links (
  companion_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN ('followup','supplement','correction','contradiction','alias')),
  CHECK(from_id<>to_id), PRIMARY KEY(companion_id,from_id,to_id,relation),
  FOREIGN KEY(companion_id,from_id) REFERENCES memory_records(companion_id,id),
  FOREIGN KEY(companion_id,to_id) REFERENCES memory_records(companion_id,id)
) STRICT;
CREATE TABLE source_suppressions (
  companion_id TEXT NOT NULL, source_item_id TEXT NOT NULL, memory_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('retracted','corrected')), generation INTEGER NOT NULL CHECK(generation>=1),
  PRIMARY KEY(companion_id,source_item_id,memory_id),
  FOREIGN KEY(companion_id,source_item_id) REFERENCES source_items(companion_id,id),
  FOREIGN KEY(companion_id,memory_id) REFERENCES memory_records(companion_id,id)
) STRICT;

CREATE TABLE index_state (
  companion_id TEXT PRIMARY KEY REFERENCES companions(id), active_generation INTEGER NOT NULL CHECK(active_generation>=1),
  index_schema_version TEXT NOT NULL, catchup_watermark_json TEXT NOT NULL CHECK(json_valid(catchup_watermark_json))
) STRICT;
CREATE TABLE search_documents (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, memory_id TEXT NOT NULL, memory_version INTEGER NOT NULL,
  suppression_generation INTEGER NOT NULL CHECK(suppression_generation>=0),
  index_schema_version TEXT NOT NULL, build_generation INTEGER NOT NULL CHECK(build_generation>=1), summary TEXT NOT NULL,
  UNIQUE(companion_id,id), UNIQUE(companion_id,memory_id,build_generation),
  FOREIGN KEY(companion_id,memory_id,memory_version) REFERENCES memory_revisions(companion_id,memory_id,version)
) STRICT;
CREATE TABLE search_terms (
  companion_id TEXT NOT NULL, document_id TEXT NOT NULL, term TEXT NOT NULL, weight REAL NOT NULL CHECK(weight>=0),
  PRIMARY KEY(companion_id,document_id,term),
  FOREIGN KEY(companion_id,document_id) REFERENCES search_documents(companion_id,id)
) STRICT;
CREATE INDEX term_candidates ON search_terms(companion_id,term);

CREATE TABLE archives (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL REFERENCES companions(id), format TEXT NOT NULL CHECK(format='fish-archive-v1'),
  manifest_object_id TEXT NOT NULL, payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^a-f0-9]*'),
  storage_key TEXT NOT NULL UNIQUE,
  compressed_bytes INTEGER NOT NULL CHECK(compressed_bytes>0), uncompressed_bytes INTEGER NOT NULL CHECK(uncompressed_bytes>0),
  status TEXT NOT NULL CHECK(status IN ('prepared','ready')),
  UNIQUE(companion_id,id),
  FOREIGN KEY(companion_id,manifest_object_id) REFERENCES content_objects(companion_id,id)
) STRICT;
CREATE TABLE archive_members (
  companion_id TEXT NOT NULL, archive_id TEXT NOT NULL, member_id TEXT NOT NULL, object_id TEXT NOT NULL,
  offset_bytes INTEGER NOT NULL CHECK(offset_bytes>=0), compressed_bytes INTEGER NOT NULL CHECK(compressed_bytes>0),
  content_sha256 TEXT NOT NULL, uncompressed_bytes INTEGER NOT NULL CHECK(uncompressed_bytes>0),
  PRIMARY KEY(companion_id,archive_id,member_id), UNIQUE(companion_id,archive_id,member_id,object_id),
  FOREIGN KEY(companion_id,archive_id) REFERENCES archives(companion_id,id),
  FOREIGN KEY(companion_id,object_id,content_sha256,uncompressed_bytes) REFERENCES content_objects(companion_id,id,sha256,byte_length)
) STRICT;
CREATE TRIGGER archive_ready_immutable BEFORE UPDATE ON archives WHEN OLD.status='ready'
BEGIN SELECT RAISE(ABORT,'published archive is immutable'); END;
CREATE TRIGGER archive_member_published_insert BEFORE INSERT ON archive_members
WHEN (SELECT status FROM archives WHERE companion_id=NEW.companion_id AND id=NEW.archive_id)='ready'
BEGIN SELECT RAISE(ABORT,'published archive members are immutable'); END;
CREATE TRIGGER archive_member_immutable BEFORE UPDATE ON archive_members
BEGIN SELECT RAISE(ABORT,'archive member is immutable'); END;
CREATE TRIGGER archive_member_delete_guard BEFORE DELETE ON archive_members
BEGIN SELECT RAISE(ABORT,'archive member is immutable'); END;
CREATE TRIGGER location_archive_ready_insert BEFORE INSERT ON object_locations WHEN NEW.archive_id IS NOT NULL
  AND COALESCE((SELECT status FROM archives WHERE companion_id=NEW.companion_id AND id=NEW.archive_id),'missing')<>'ready'
BEGIN SELECT RAISE(ABORT,'archive must be ready before relocating content'); END;
CREATE TRIGGER location_archive_ready_update BEFORE UPDATE ON object_locations WHEN NEW.archive_id IS NOT NULL
  AND COALESCE((SELECT status FROM archives WHERE companion_id=NEW.companion_id AND id=NEW.archive_id),'missing')<>'ready'
BEGIN SELECT RAISE(ABORT,'archive must be ready before relocating content'); END;
CREATE TRIGGER inline_length_insert BEFORE INSERT ON object_locations WHEN NEW.inline_bytes IS NOT NULL
  AND length(NEW.inline_bytes)<>(SELECT byte_length FROM content_objects WHERE companion_id=NEW.companion_id AND id=NEW.object_id)
BEGIN SELECT RAISE(ABORT,'inline byte length differs from content identity'); END;
CREATE TRIGGER inline_length_update BEFORE UPDATE ON object_locations WHEN NEW.inline_bytes IS NOT NULL
  AND length(NEW.inline_bytes)<>(SELECT byte_length FROM content_objects WHERE companion_id=NEW.companion_id AND id=NEW.object_id)
BEGIN SELECT RAISE(ABORT,'inline byte length differs from content identity'); END;

CREATE TABLE credentials (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL REFERENCES companions(id), token_sha256 TEXT NOT NULL UNIQUE CHECK(length(token_sha256)=64 AND token_sha256 NOT GLOB '*[^a-f0-9]*'),
  capability TEXT NOT NULL CHECK(capability IN ('read','observe','user_edit','admin')),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), UNIQUE(companion_id,id)
) STRICT;
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL REFERENCES companions(id),
  kind TEXT NOT NULL CHECK(kind IN ('extract','reinterpret','archive','reindex','import')),
  idempotency_key TEXT NOT NULL, input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  status TEXT NOT NULL CHECK(status IN ('queued','running','retry_wait','completed','stale','failed','cancelled')),
  lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), error_code TEXT,
  UNIQUE(companion_id,id), UNIQUE(companion_id,kind,idempotency_key)
) STRICT;
CREATE TABLE write_requests (
  companion_id TEXT NOT NULL, credential_id TEXT NOT NULL, tool_name TEXT NOT NULL, request_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^a-f0-9]*'), result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  PRIMARY KEY(companion_id,credential_id,tool_name,request_id),
  FOREIGN KEY(companion_id,credential_id) REFERENCES credentials(companion_id,id)
) STRICT;
CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, source_id TEXT NOT NULL, snapshot_object_id TEXT NOT NULL,
  rule_version TEXT NOT NULL, identity_map_json TEXT NOT NULL CHECK(json_valid(identity_map_json)),
  status TEXT NOT NULL CHECK(status IN ('staged','running','completed','failed','undone')),
  UNIQUE(companion_id,id),
  FOREIGN KEY(companion_id,source_id) REFERENCES sources(companion_id,id),
  FOREIGN KEY(companion_id,snapshot_object_id) REFERENCES content_objects(companion_id,id)
) STRICT;
CREATE TABLE import_items (
  companion_id TEXT NOT NULL, import_job_id TEXT NOT NULL, source_record_id TEXT NOT NULL, memory_id TEXT,
  disposition TEXT NOT NULL CHECK(disposition IN ('staged','created','contributed','skipped','failed','undone')),
  PRIMARY KEY(companion_id,import_job_id,source_record_id),
  FOREIGN KEY(companion_id,import_job_id) REFERENCES import_jobs(companion_id,id),
  FOREIGN KEY(companion_id,source_record_id) REFERENCES source_records(companion_id,id),
  FOREIGN KEY(companion_id,memory_id) REFERENCES memory_records(companion_id,id)
) STRICT;

CREATE TRIGGER content_object_immutable BEFORE UPDATE ON content_objects BEGIN SELECT RAISE(ABORT,'content identity is immutable'); END;
CREATE TRIGGER content_object_delete_guard BEFORE DELETE ON content_objects BEGIN SELECT RAISE(ABORT,'content identity is immutable'); END;
CREATE TRIGGER content_location_delete_guard BEFORE DELETE ON object_locations BEGIN SELECT RAISE(ABORT,'content location cannot be removed'); END;
CREATE TRIGGER turn_version_immutable BEFORE UPDATE ON turn_versions BEGIN SELECT RAISE(ABORT,'message version is immutable'); END;
CREATE TRIGGER turn_version_delete_guard BEFORE DELETE ON turn_versions BEGIN SELECT RAISE(ABORT,'message version is immutable'); END;
CREATE TRIGGER source_record_immutable BEFORE UPDATE ON source_records BEGIN SELECT RAISE(ABORT,'source version is immutable'); END;
CREATE TRIGGER source_record_delete_guard BEFORE DELETE ON source_records BEGIN SELECT RAISE(ABORT,'source version is immutable'); END;
CREATE TRIGGER revision_immutable BEFORE UPDATE ON memory_revisions BEGIN SELECT RAISE(ABORT,'memory revision is immutable'); END;
CREATE TRIGGER revision_delete_guard BEFORE DELETE ON memory_revisions BEGIN SELECT RAISE(ABORT,'memory revision is immutable'); END;
CREATE TRIGGER evidence_immutable BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT,'evidence is immutable'); END;
CREATE TRIGGER evidence_delete_guard BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT,'evidence is immutable'); END;

-- Application semantic validation still required: genuine consent and emotion,
-- active branch ancestry, contiguous watermarks, source suppression on reimport,
-- evidence substring/hash verification, atomic patch-set commit, index catch-up,
-- physical archive integrity/publication and backup policy. DDL cannot prove these.
