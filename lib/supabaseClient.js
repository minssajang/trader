import { createClient } from '@supabase/supabase-js'

// 브라우저에서 직접 쓰는 클라이언트 - lib/supabase.js(서버 전용, service role key로 전체 권한)와는
// 완전히 별개. publishable key(예전 이름 "anon key")는 브라우저에 노출돼도 안전하다(RLS로 막혀있고,
// live_candles는 원래도 인증 없는 공개 GET이었던 가격 데이터라 read 권한만 여는 것도 기존 보안
// 수준과 동일 - trade_commands/account_status처럼 실제로 의미 있는 데이터는 이 클라이언트로 안
// 건드림, API 라우트를 그대로 거침). Vercel에 이미 설정돼 있던 NEXT_PUBLIC_SUPABASE_URL /
// NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY를 그대로 재사용한다(새로 추가 안 해도 됨).
// 라이브 페이지가 Supabase Realtime(웹소켓)으로 새 캔들을 "물어보지 않고" 즉시 밀어받기 위해 도입함.
export const supabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
)
