-- trader 프로젝트: 쿠팡 파트너스 링크/배너 관리 (광고 관리 - 쿠팡 소스 연동용)
-- Supabase SQL Editor에서 그대로 실행하세요.

create table if not exists coupang_widgets (
  id text primary key,
  label text default '',
  size text default '',
  widget_html text default '',
  enabled boolean default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
alter table coupang_widgets enable row level security;

create table if not exists coupang_links (
  id text primary key,
  label text default '',
  url text default '',
  enabled boolean default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
alter table coupang_links enable row level security;
