import { supabase } from '../../../lib/supabase'

export default async function handler(req, res) {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ error: '인증 필요' })
  }
  if (req.method !== 'POST') return res.status(405).end()

  const { path } = req.body || {}
  if (!path) return res.status(400).json({ error: 'path 필요' })

  try {
    const { error } = await supabase.storage.from('blog-images').remove([path])
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
