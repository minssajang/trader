import { supabase } from '../../lib/supabase'

// 학습(backtest-chart) 페이지의 라벨링(진입롱/진입숏/횡보시작/횡보끝/추세시작/추세끝/청산) 기록을
// 그 시점까지 드러난 차트 데이터와 함께 저장한다. 화면에 결과를 보여주는 기능이 아니라, 나중에
// Claude가 MCP(run_sql)로 이 테이블을 조회해서 학습 데이터로 쓸 수 있게 쌓아두는 용도.
// 인증 없음 - backtest-chart 페이지 자체가 로그인 없는 공개 페이지라 다른 공개 API와 같은 수준.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { symbol, date_from, date_to, annotations, chart_data } = req.body || {}
  if (!symbol || !date_from || !date_to || !Array.isArray(annotations) || annotations.length === 0 || !chart_data) {
    return res.status(400).json({ error: '필수 값 누락' })
  }

  const { data, error } = await supabase
    .from('chart_annotations')
    .insert({ symbol, date_from, date_to, annotations, chart_data })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  return res.json({ ok: true, id: data.id })
}
