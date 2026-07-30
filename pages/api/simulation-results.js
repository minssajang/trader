import { supabase } from '../../lib/supabase'

// 백테스팅 시뮬레이션에서 청산된 거래 기록을 저장한다. 화면에 결과를 보여주는 기능이 아니라,
// Claude가 나중에 대화 중 MCP(run_sql)로 이 테이블을 조회해서 분석해줄 수 있게 쌓아두는 용도.
// 인증 없음 - backtest-chart 페이지 자체가 로그인 없는 공개 페이지라 다른 공개 API(backtest-datasets-public)와 같은 수준.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { symbol, date_from, date_to, starting_balance, ending_balance, config, trades } = req.body || {}
  if (!symbol || !date_from || !date_to || !Array.isArray(trades) || trades.length === 0) {
    return res.status(400).json({ error: '필수 값 누락' })
  }

  const { data, error } = await supabase
    .from('simulation_results')
    .insert({
      symbol, date_from, date_to,
      starting_balance: starting_balance ?? null,
      ending_balance: ending_balance ?? null,
      config: config ?? {},
      trades,
    })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  return res.json({ ok: true, id: data.id })
}
