-- trader 프로젝트: 블로그 시스템 풀 기능 확장 (fresh-season 블로그 CMS 1:1 이식)
-- Supabase SQL Editor에서 그대로 실행하세요. (003_blog_posts.sql 다음에 실행)

alter table blog_posts add column if not exists tags jsonb default '[]'::jsonb;
alter table blog_posts add column if not exists cover_image text;
alter table blog_posts add column if not exists author_name text;
alter table blog_posts add column if not exists post_type text default 'blog';
alter table blog_posts add column if not exists scheduled_at timestamptz;
alter table blog_posts add column if not exists updated_at timestamptz;

-- 제목 점수·SEO 점수·네이버 요약글·인스타 카드뉴스 — 관리자 전용 참고자료 (공개 API에서는 제외됨)
alter table blog_posts add column if not exists title_score numeric;
alter table blog_posts add column if not exists seo_score numeric;
alter table blog_posts add column if not exists title_score_detail jsonb;
alter table blog_posts add column if not exists seo_score_detail jsonb;
alter table blog_posts add column if not exists naver_summary text;
alter table blog_posts add column if not exists instagram_cards text;

-- 커스텀 블로그 카테고리 관리 (admin 블로그 메뉴관리에서 추가/삭제)
create table if not exists blog_categories (
  id text primary key,
  label text not null,
  slug text,
  icon text,
  created_at timestamptz not null default now()
);
alter table blog_categories enable row level security;

-- 관리자 화면 SEO 체크리스트 · 루틴 달력 저장용
create table if not exists admin_checklist (
  key text primary key,
  value jsonb
);
alter table admin_checklist enable row level security;
