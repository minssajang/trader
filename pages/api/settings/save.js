import { supabase } from '../../../lib/supabase'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  const token = req.headers['x-admin-token']
  if (!process.env.ADMIN_SECRET_TOKEN || token !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ error: '인증 실패' })
  }

  const { adSlots, adsOn } = req.body
  const rows = []
  if (adSlots !== undefined) rows.push({ key: 'site:ad_slots', value: JSON.stringify(adSlots) })
  if (adsOn !== undefined) rows.push({ key: 'site:ads_on', value: String(!!adsOn) })
  if (rows.length === 0) return res.status(400).json({ error: '저장할 데이터 없음' })

  try {
    const { error } = await supabase.from('settings').upsert(rows, { onConflict: 'key' })
    if (error) throw error
    res.status(200).json({ ok: true })
  } catch {
    res.status(500).json({ error: 'DB 저장 실패' })
  }
}
