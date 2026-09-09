CREATE TABLE dsh_session_header (
  id text PRIMARY KEY,
  header bytea NOT NULL,
  inherited_event_count bigint NOT NULL,
  event_count bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dsh_session_event (
  session_id text NOT NULL REFERENCES dsh_session_header(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  event bytea NOT NULL,
  type text,
  event_time bigint,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX dsh_session_event_type_idx ON dsh_session_event (session_id, type);
CREATE INDEX dsh_session_event_time_idx ON dsh_session_event (event_time);
CREATE TABLE dsh_session_message (
  session_id text NOT NULL REFERENCES dsh_session_header(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  message_id text,
  role text NOT NULL,
  content jsonb,
  create_time bigint NOT NULL,
  model text,
  provider text,
  tool_name text,
  call_id text,
  input_tokens bigint,
  output_tokens bigint,
  total_tokens bigint,
  cache_read_tokens bigint,
  cache_write_tokens bigint,
  reasoning_tokens bigint,
  replaces_start_seq bigint,
  replaces_end_seq bigint,
  source_event_seqs bigint[],
  content_tsv tsvector GENERATED ALWAYS AS (jsonb_to_tsvector('simple', coalesce(content, '{}'::jsonb), '["string"]')) STORED,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX dsh_session_message_role_idx ON dsh_session_message (session_id, role);
CREATE INDEX dsh_session_message_id_idx ON dsh_session_message (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX dsh_session_message_tool_name_idx ON dsh_session_message (tool_name) WHERE tool_name IS NOT NULL;
CREATE INDEX dsh_session_message_call_id_idx ON dsh_session_message (call_id) WHERE call_id IS NOT NULL;
CREATE INDEX dsh_session_message_content_idx ON dsh_session_message USING GIN (content jsonb_path_ops);
CREATE INDEX dsh_session_message_content_tsv_idx ON dsh_session_message USING GIN (content_tsv);
