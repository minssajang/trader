// 브라우저에서 직접 호출하는 공개용 Supabase 설정.
// publishable key는 공개돼도 안전 - RLS + RPC 3개로만 접근 범위를 제한해둠.
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ztrdgcebsxbhtckstlhn.supabase.co'
const SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_uGZpG_7yvdHw_V12dcvXNw_NoEaWHfe'

// 관리자 페이지에서 큰 설치 파일(exe)을 Supabase Storage에 signed URL로 직접 업로드할 때 씀.
// publishable key로는 서버가 발급해준 signed URL로만 쓸 수 있고, 아무 파일이나 막 올릴 수 없다.
export const publicSupabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)

export async function callRpc(fnName, params) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`요청 실패 (${res.status}): ${text}`)
  }
  return res.json()
}
