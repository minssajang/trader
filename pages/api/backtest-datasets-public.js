import { supabase } from '../../lib/supabase'

// 라이브 차트 페이지(누구나 접근)에서 심볼별 업로드된 데이터셋 목록을 볼 때 씀.
// 인증 없이 목록/메타데이터만 제공 — 실제 CSV는 backtest-data가 public 버킷이라
// storage_path로 클라이언트가 직접 받는다.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end()

  const { symbol } = req.query
  let query = supabase.from('backtest_datasets').select('*').order('date_from', { ascending: true })
  if (symbol) query = query.eq('symbol', symbol)

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  return res.json({ rows: data || [] })
}
