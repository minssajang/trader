-- trader 프로젝트: 자유게시판 (blog_posts 테이블 재사용, post_type='free'로 구분)
-- Supabase SQL Editor에서 그대로 실행하세요. (004_blog_posts_full.sql 다음에 실행)

alter table blog_posts add column if not exists is_secret boolean default false;
alter table blog_posts add column if not exists password_hash text;
