ALTER TABLE jobs ADD COLUMN lease_token TEXT;
ALTER TABLE jobs ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation>=0);
ALTER TABLE jobs ADD COLUMN available_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE jobs ADD COLUMN result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json));
ALTER TABLE turns ADD COLUMN external_id TEXT;
ALTER TABLE messages ADD COLUMN external_id TEXT;
ALTER TABLE interpretations ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX external_turn_identity ON turns(companion_id,conversation_id,branch_id,external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX external_message_identity ON messages(companion_id,turn_id,external_id) WHERE external_id IS NOT NULL;
CREATE INDEX ready_jobs ON jobs(companion_id,status,available_at,lease_until);
CREATE UNIQUE INDEX receipt_turn_scope ON turns(companion_id,conversation_id,branch_id,id);

CREATE TABLE turn_receipts (
  companion_id TEXT NOT NULL, conversation_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  turn_id TEXT NOT NULL, chain_revision INTEGER NOT NULL CHECK(chain_revision>=1),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64), job_id TEXT NOT NULL,
  PRIMARY KEY(companion_id,conversation_id,branch_id,turn_id,chain_revision),
  FOREIGN KEY(companion_id,conversation_id,branch_id) REFERENCES branches(companion_id,conversation_id,id),
  FOREIGN KEY(companion_id,conversation_id,branch_id,turn_id) REFERENCES turns(companion_id,conversation_id,branch_id,id),
  FOREIGN KEY(companion_id,job_id) REFERENCES jobs(companion_id,id)
) STRICT;
CREATE TRIGGER receipt_immutable BEFORE UPDATE ON turn_receipts BEGIN SELECT RAISE(ABORT,'turn receipt is immutable'); END;
CREATE TRIGGER receipt_delete_guard BEFORE DELETE ON turn_receipts BEGIN SELECT RAISE(ABORT,'turn receipt is immutable'); END;
CREATE TABLE evidence_catalog (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, content_object_id TEXT NOT NULL,
  UNIQUE(companion_id,id),
  FOREIGN KEY(companion_id,content_object_id) REFERENCES content_objects(companion_id,id)
) STRICT;
CREATE TABLE revision_evidence (
  companion_id TEXT NOT NULL, memory_revision_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
  PRIMARY KEY(companion_id,memory_revision_id,evidence_id),
  FOREIGN KEY(companion_id,memory_revision_id) REFERENCES memory_revisions(companion_id,id),
  FOREIGN KEY(companion_id,evidence_id) REFERENCES evidence_catalog(companion_id,id)
) STRICT;
CREATE TABLE revision_inputs (
  companion_id TEXT NOT NULL, memory_revision_id TEXT NOT NULL, turn_version_id TEXT NOT NULL,
  PRIMARY KEY(companion_id,memory_revision_id,turn_version_id),
  FOREIGN KEY(companion_id,memory_revision_id) REFERENCES memory_revisions(companion_id,id),
  FOREIGN KEY(companion_id,turn_version_id) REFERENCES turn_versions(companion_id,id)
) STRICT;
CREATE TABLE memory_validity (
  companion_id TEXT NOT NULL, memory_id TEXT NOT NULL, version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('valid','stale')), reason TEXT,
  PRIMARY KEY(companion_id,memory_id),
  FOREIGN KEY(companion_id,memory_id,version) REFERENCES memory_revisions(companion_id,memory_id,version)
) STRICT;
CREATE TABLE job_candidates (
  companion_id TEXT NOT NULL, job_id TEXT NOT NULL, lease_generation INTEGER NOT NULL CHECK(lease_generation>=1),
  content_object_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('staged','committed','stale')),
  PRIMARY KEY(companion_id,job_id,lease_generation),
  FOREIGN KEY(companion_id,job_id) REFERENCES jobs(companion_id,id),
  FOREIGN KEY(companion_id,content_object_id) REFERENCES content_objects(companion_id,id)
) STRICT;
CREATE TRIGGER request_immutable BEFORE UPDATE ON write_requests BEGIN SELECT RAISE(ABORT,'request receipt is immutable'); END;
CREATE TRIGGER request_delete_guard BEFORE DELETE ON write_requests BEGIN SELECT RAISE(ABORT,'request receipt is immutable'); END;
CREATE TRIGGER catalog_immutable BEFORE UPDATE ON evidence_catalog BEGIN SELECT RAISE(ABORT,'evidence identity is immutable'); END;
CREATE TRIGGER catalog_delete_guard BEFORE DELETE ON evidence_catalog BEGIN SELECT RAISE(ABORT,'evidence identity is immutable'); END;
CREATE TRIGGER revision_evidence_immutable BEFORE UPDATE ON revision_evidence BEGIN SELECT RAISE(ABORT,'revision evidence is immutable'); END;
CREATE TRIGGER revision_evidence_delete BEFORE DELETE ON revision_evidence BEGIN SELECT RAISE(ABORT,'revision evidence is immutable'); END;
CREATE TRIGGER revision_inputs_immutable BEFORE UPDATE ON revision_inputs BEGIN SELECT RAISE(ABORT,'revision input is immutable'); END;
CREATE TRIGGER revision_inputs_delete BEFORE DELETE ON revision_inputs BEGIN SELECT RAISE(ABORT,'revision input is immutable'); END;
