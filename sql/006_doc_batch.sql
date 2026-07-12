-- trader 프로젝트: 키워드 문서수(경쟁도) 배치 수집용 (fresh-season doc-batch 기능 이식)
-- Supabase SQL Editor에서 그대로 실행하세요. (005_keyword_tools.sql 다음에 실행)

alter table keyword_stats add column if not exists doc_count integer;

create table if not exists doc_batch_log (
  date text primary key,
  used integer default 0,
  updated_at timestamptz default now()
);
alter table doc_batch_log enable row level security;
