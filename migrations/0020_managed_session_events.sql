ALTER TABLE managed_sessions
  ADD COLUMN received_event_seq BIGINT NOT NULL DEFAULT 0 CHECK (received_event_seq >= 0);

ALTER TABLE runs
  ADD COLUMN awaited_signal_correlation_id TEXT,
  ADD COLUMN awaited_signal_schema JSONB;

CREATE TABLE managed_session_events (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  session_id          TEXT NOT NULL,
  source_type         TEXT NOT NULL,
  source_id           TEXT NOT NULL,
  source_event_id     TEXT NOT NULL,
  source_sequence     BIGINT,
  payload_digest      TEXT NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  received_sequence   BIGINT NOT NULL CHECK (received_sequence > 0),
  api_version         TEXT NOT NULL,
  type                TEXT NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL,
  subject             JSONB,
  data                JSONB NOT NULL DEFAULT '{}'::jsonb,
  input_snapshot_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  correlation_id      TEXT,
  dispatch_class      TEXT NOT NULL CHECK (dispatch_class IN ('current-run', 'future-run')),
  status              TEXT NOT NULL CHECK (status IN ('PENDING', 'CONSUMED', 'DISPATCHED', 'STALE')),
  status_reason       TEXT,
  run_id              TEXT REFERENCES runs(id),
  dispatch_after      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at         TIMESTAMPTZ,
  CHECK (
    (dispatch_class = 'current-run' AND type = 'kertas.signal.received')
    OR (dispatch_class = 'future-run'
        AND type IN ('kertas.objective.requested', 'kertas.feedback.received'))
  ),
  CHECK (
    (status = 'PENDING' AND run_id IS NULL AND consumed_at IS NULL AND status_reason IS NULL)
    OR (status IN ('CONSUMED', 'DISPATCHED')
        AND run_id IS NOT NULL AND consumed_at IS NOT NULL AND status_reason IS NULL)
    OR (status = 'STALE' AND consumed_at IS NOT NULL AND status_reason IS NOT NULL)
  ),
  UNIQUE (tenant_id, source_type, source_id, source_event_id),
  UNIQUE (session_id, received_sequence),
  CONSTRAINT managed_session_events_session_tenant_fk
    FOREIGN KEY (session_id, tenant_id) REFERENCES managed_sessions(id, tenant_id)
);

CREATE INDEX managed_session_events_pending
  ON managed_session_events (session_id, received_sequence)
  WHERE status = 'PENDING';

CREATE OR REPLACE FUNCTION guard_managed_session_event_receipt() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'managed session event receipts are immutable';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.session_id IS DISTINCT FROM NEW.session_id
     OR OLD.source_type IS DISTINCT FROM NEW.source_type
     OR OLD.source_id IS DISTINCT FROM NEW.source_id
     OR OLD.source_event_id IS DISTINCT FROM NEW.source_event_id
     OR OLD.source_sequence IS DISTINCT FROM NEW.source_sequence
     OR OLD.payload_digest IS DISTINCT FROM NEW.payload_digest
     OR OLD.received_sequence IS DISTINCT FROM NEW.received_sequence
     OR OLD.api_version IS DISTINCT FROM NEW.api_version
     OR OLD.type IS DISTINCT FROM NEW.type
     OR OLD.occurred_at IS DISTINCT FROM NEW.occurred_at
     OR OLD.subject IS DISTINCT FROM NEW.subject
     OR OLD.data IS DISTINCT FROM NEW.data
     OR OLD.input_snapshot_refs IS DISTINCT FROM NEW.input_snapshot_refs
     OR OLD.correlation_id IS DISTINCT FROM NEW.correlation_id
     OR OLD.dispatch_class IS DISTINCT FROM NEW.dispatch_class
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'managed session event receipt payload is immutable';
  END IF;
  IF OLD.status <> 'PENDING'
     OR NEW.status NOT IN ('CONSUMED', 'DISPATCHED', 'STALE') THEN
    IF OLD.status = 'PENDING' AND NEW.status = 'PENDING'
       AND NEW.dispatch_after > OLD.dispatch_after THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid managed session event lifecycle transition';
  END IF;
  IF NEW.status IN ('CONSUMED', 'DISPATCHED') AND NEW.run_id IS NULL THEN
    RAISE EXCEPTION 'consumed or dispatched session event requires a run';
  END IF;
  IF (NEW.status = 'CONSUMED' AND OLD.dispatch_class <> 'current-run')
     OR (NEW.status = 'DISPATCHED' AND OLD.dispatch_class <> 'future-run') THEN
    RAISE EXCEPTION 'session event lifecycle does not match dispatch class';
  END IF;
  IF NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'terminal session event receipt requires consumed_at';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER managed_session_events_receipt_guard
  BEFORE UPDATE OR DELETE ON managed_session_events
  FOR EACH ROW EXECUTE FUNCTION guard_managed_session_event_receipt();
