CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  status text NOT NULL CHECK (status = 'SUCCEEDED'),
  applied_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.app_user (
  id text PRIMARY KEY,
  cognito_subject text NOT NULL UNIQUE,
  username_snapshot text NOT NULL,
  role text NOT NULL CHECK (role IN ('ADMIN', 'KITCHEN')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.shift (
  id text PRIMARY KEY,
  name text NOT NULL,
  sort_order integer NOT NULL CHECK (sort_order > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.responsible_person (
  id text PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.app_settings (
  id text PRIMARY KEY,
  register_float_amount integer NOT NULL DEFAULT 0
    CHECK (register_float_amount BETWEEN 0 AND 2000000000),
  setup_completed boolean NOT NULL DEFAULT false,
  updated_by_user_id text REFERENCES public.app_user(id) ON DELETE RESTRICT,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.daily_report (
  id text PRIMARY KEY,
  report_date date NOT NULL,
  shift_id text NOT NULL REFERENCES public.shift(id) ON DELETE RESTRICT,
  shift_name_snapshot text NOT NULL,
  responsible_person_id text NOT NULL REFERENCES public.responsible_person(id) ON DELETE RESTRICT,
  responsible_person_snapshot text NOT NULL,
  start_minute_of_day integer NOT NULL CHECK (start_minute_of_day BETWEEN 0 AND 1439),
  end_minute_of_day integer NOT NULL CHECK (end_minute_of_day BETWEEN 0 AND 1439),
  time_range_label_snapshot text NOT NULL,
  register_float_amount_snapshot integer NOT NULL
    CHECK (register_float_amount_snapshot BETWEEN 0 AND 2000000000),
  previous_imos_balance_yen integer NOT NULL DEFAULT 0
    CHECK (previous_imos_balance_yen BETWEEN 0 AND 2000000000),
  current_imos_balance_yen integer NOT NULL DEFAULT 0
    CHECK (current_imos_balance_yen BETWEEN 0 AND 2000000000),
  newage_yen integer NOT NULL DEFAULT 0
    CHECK (newage_yen BETWEEN 0 AND 2000000000),
  cash_total_yen integer NOT NULL DEFAULT 0
    CHECK (cash_total_yen BETWEEN 0 AND 2000000000),
  expense_yen integer NOT NULL DEFAULT 0
    CHECK (expense_yen BETWEEN 0 AND 2000000000),
  expense_reason text,
  staff_meal_cash_yen integer NOT NULL DEFAULT 0
    CHECK (staff_meal_cash_yen BETWEEN 0 AND 2000000000),
  staff_meal_alipay_yen integer NOT NULL DEFAULT 0
    CHECK (staff_meal_alipay_yen BETWEEN 0 AND 2000000000),
  imos_sales_yen bigint NOT NULL,
  cash_deposit_yen bigint NOT NULL,
  total_sales_yen bigint NOT NULL,
  deviation_yen bigint NOT NULL,
  status text NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('APPROVED')),
  idempotency_key text NOT NULL,
  created_by_user_id text NOT NULL REFERENCES public.app_user(id) ON DELETE RESTRICT,
  created_by_cognito_subject_snapshot text NOT NULL,
  created_by_username_snapshot text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (start_minute_of_day <> end_minute_of_day),
  UNIQUE (idempotency_key),
  UNIQUE (report_date, shift_id)
);

CREATE INDEX daily_report_report_date_idx ON public.daily_report (report_date);
CREATE INDEX daily_report_created_by_date_idx
  ON public.daily_report (created_by_user_id, report_date);

CREATE TABLE public.daily_report_revision (
  id text PRIMARY KEY,
  daily_report_id text NOT NULL REFERENCES public.daily_report(id) ON DELETE RESTRICT,
  before_snapshot jsonb NOT NULL,
  after_snapshot jsonb NOT NULL,
  corrected_by_user_id text NOT NULL REFERENCES public.app_user(id) ON DELETE RESTRICT,
  corrected_by_cognito_subject_snapshot text NOT NULL,
  corrected_by_username_snapshot text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX daily_report_revision_report_created_idx
  ON public.daily_report_revision (daily_report_id, created_at);

CREATE TABLE public.attachment (
  id text PRIMARY KEY,
  daily_report_id text NOT NULL REFERENCES public.daily_report(id) ON DELETE RESTRICT,
  s3_object_key text NOT NULL UNIQUE,
  original_file_name text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 0 AND 5242880),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by_user_id text NOT NULL REFERENCES public.app_user(id) ON DELETE RESTRICT,
  uploaded_by_cognito_subject_snapshot text NOT NULL,
  uploaded_by_username_snapshot text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX attachment_daily_report_idx ON public.attachment (daily_report_id);

CREATE TABLE public.export_job (
  id text PRIMARY KEY,
  export_type text NOT NULL CHECK (export_type IN ('EXCEL', 'PDF', 'PRINTABLE_HTML')),
  filter_snapshot jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
  s3_object_key text,
  failure_reason text,
  created_by_user_id text NOT NULL REFERENCES public.app_user(id) ON DELETE RESTRICT,
  created_by_cognito_subject_snapshot text NOT NULL,
  created_by_username_snapshot text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamp with time zone,
  CHECK (status <> 'SUCCEEDED' OR s3_object_key IS NOT NULL),
  CHECK (status <> 'FAILED' OR failure_reason IS NOT NULL)
);

CREATE INDEX export_job_creator_created_idx
  ON public.export_job (created_by_user_id, created_at);

CREATE TABLE public.migration_run (
  id text PRIMARY KEY,
  migration_version text NOT NULL,
  source_backup_sha256 text NOT NULL
    CHECK (source_backup_sha256 ~ '^[0-9a-f]{64}$'),
  source_s3_object_key text NOT NULL,
  stage text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  total_item_count integer NOT NULL DEFAULT 0 CHECK (total_item_count >= 0),
  succeeded_item_count integer NOT NULL DEFAULT 0 CHECK (succeeded_item_count >= 0),
  failed_item_count integer NOT NULL DEFAULT 0 CHECK (failed_item_count >= 0),
  source_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  migrated_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_summary jsonb,
  error_message text,
  created_by_user_id text NOT NULL REFERENCES public.app_user(id) ON DELETE RESTRICT,
  created_by_cognito_subject_snapshot text NOT NULL,
  created_by_username_snapshot text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamp with time zone,
  UNIQUE (migration_version, source_backup_sha256),
  CHECK (succeeded_item_count + failed_item_count <= total_item_count),
  CHECK (status <> 'FAILED' OR error_message IS NOT NULL)
);

CREATE TABLE public.migration_item (
  id text PRIMARY KEY,
  migration_run_id text NOT NULL REFERENCES public.migration_run(id) ON DELETE CASCADE,
  item_type text NOT NULL,
  source_id text NOT NULL,
  target_id text,
  source_sha256 text CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'SKIPPED')),
  error_message text,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (migration_run_id, item_type, source_id),
  CHECK (status <> 'FAILED' OR error_message IS NOT NULL)
);

CREATE INDEX migration_item_run_status_idx
  ON public.migration_item (migration_run_id, status);
