import { supabase } from '../../../lib/supabase'

export default async function handler(req, res) {
  const token = req.headers['x-admin-token']
  if (!process.env.ADMIN_SECRET_TOKEN || token !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ error: '인증 필요' })
  }

  if (req.method === 'GET') {
    try {
      const { data } = await supabase.from('admin_checklist').select('key, value')
      const map = {}
      for (const row of data || []) map[row.key] = row.value
      return res.status(200).json({ checklist: map['checklist'] || {}, routine: map['routine'] || {} })
    } catch {
      return res.status(200).json({ checklist: {}, routine: {} })
    }
  }

  if (req.method === 'POST') {
    const { checklist, routine } = req.body
    try {
      const rows = []
      if (checklist !== undefined) rows.push({ key: 'checklist', value: checklist })
      if (routine !== undefined) rows.push({ key: 'routine', value: routine })
      if (rows.length > 0) await supabase.from('admin_checklist').upsert(rows, { onConflict: 'key' })
      return res.status(200).json({ ok: true })
    } catch {
      return res.status(500).json({ error: '저장 실패' })
    }
  }

  res.status(405).end()
}
