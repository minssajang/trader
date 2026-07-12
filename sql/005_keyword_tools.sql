-- trader 프로젝트: 블로그 키워드 리서치 + 발행 기록 툴 (fresh-season MCP 키워드 툴셋 이식)
-- Supabase SQL Editor에서 그대로 실행하세요. (004_blog_posts_full.sql 다음에 실행)

-- 네이버 키워드 검색량 캐시 (naver_keyword_volume/search_keyword_data가 씀)
create table if not exists keyword_stats (
  hint text not null,
  keyword text not null,
  pc integer default 0,
  mobile integer default 0,
  total integer default 0,
  competition text,
  created_at timestamptz not null default now(),
  primary key (hint, keyword)
);
alter table keyword_stats enable row level security;

-- 찜한(bookmark) 키워드 (pick_keyword/search_keyword_picks/mark_keyword_used가 씀)
create table if not exists keyword_picks (
  tool_id text not null,
  hint text,
  keyword text not null,
  pc integer default 0,
  mobile integer default 0,
  total integer default 0,
  competition text,
  memo text,
  used_at timestamptz,
  used_in_title text,
  used_in_slug text,
  created_at timestamptz not null default now(),
  primary key (tool_id, keyword)
);
alter table keyword_picks enable row level security;

-- 블로그 발행 기록 (add_publish_log/get_publish_log가 씀)
create table if not exists publish_log (
  id text primary key,
  category text,
  angle text,
  title text not null,
  slug text not null,
  memo text,
  target_keyword text,
  search_pc integer,
  search_mobile integer,
  search_total integer,
  competition text,
  google_indexing text,
  index_now text,
  published_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table publish_log enable row level security;
