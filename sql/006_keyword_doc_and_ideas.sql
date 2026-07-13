-- trader 프로젝트: 키워드 문서수 수집 + 기능제안(아이디어) 테이블 보강
-- Supabase SQL Editor에서 그대로 실행하세요. (005_keyword_tools.sql 다음에 실행)

-- keyword_stats에 문서수(doc_count) 컬럼 추가 (naver_keyword_volume/doc-batch가 씀)
alter table keyword_stats
  add column if not exists doc_count integer;

-- 문서수 일일 수집량 기록 (doc-batch.js / keyword-volume.js의 mode=doc_only가 씀)
create table if not exists doc_batch_log (
  date text primary key,
  used integer default 0,
  updated_at timestamptz default now()
);
alter table doc_batch_log enable row level security;

-- 기능 추가 제안 (suggest_feature/get_feature_ideas MCP 툴, admin "💡 아이디어 제안" 탭이 씀)
create table if not exists feature_ideas (
  id text primary key,
  tool_id text not null,
  feature_name text not null,
  keyword text,
  pc integer, mobile integer, total integer, competition text,
  notes text not null,
  status text not null default 'proposed',
  created_at timestamptz not null default now()
);
alter table feature_ideas enable row level security;
