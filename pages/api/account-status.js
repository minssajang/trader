import { supabase } from '../../lib/supabase'

// 실주문 카드에 "데모/라이브 계좌, 잔고 얼마" 표시하려고 만든 API. MT5 EA가 주기적으로(예: 30초)
// 자기 계좌 정보를 올리고(POST, x-admin-token 필요), 라이브 페이지는 사용자가 입력한 account_label로
// 그 값을 읽어온다(GET, 인증 없음 - account_label 자체가 이미 이용자만 아는 비밀값이라 이걸 모르면
// 애초에 조회할 수 없음 - live-price.js/trade-command.js와 동일한 보안 모델).
export default async function handler(req, res) {
  if (req.method === 'POST') {
    const token = req.headers['x-admin-token']
    if (!process.env.ADMIN_SECRET_TOKEN || token !== process.env.ADMIN_SECRET_TOKEN) {
      return res.status(401).json({ error: '인증 필요' })
    }
    const { account_label, is_demo, balance, currency, account_login } = req.body || {}
    if (!account_label || typeof is_demo !== 'boolean' || typeof balance !== 'number') {
      return res.status(400).json({ error: '필수 값 누락(account_label, is_demo, balance)' })
    }
    const { error } = await supabase
      .from('account_status')
      .upsert(
        { account_label, is_demo, balance, currency: currency || null, account_login: account_login || null, updated_at: new Date().toISOString() },
        { onConflict: 'account_label' }
      )
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'GET') {
    const { account_label } = req.query
    if (!account_label) return res.status(400).json({ error: 'account_label 필요' })
    const { data, error } = await supabase
      .from('account_status')
      .select('is_demo, balance, currency, account_login, updated_at')
      .eq('account_label', account_label)
      .single()
    if (error) {
      if (error.code === 'PGRST116') return res.status(200).json({ status: null }) // 아직 EA가 한 번도 보고 안 함
      return res.status(500).json({ error: error.message })
    }
    return res.status(200).json({ status: data })
  }

  res.status(405).end()
}
