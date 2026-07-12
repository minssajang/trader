import { createHash } from 'crypto'
import { supabase } from '../../../lib/supabase'

function sha256(str) {
  return createHash('sha256').update(str).digest('hex')
}

function auth(req) {
  const token = req.headers['x-admin-token']
  return token && token === process.env.ADMIN_SECRET_TOKEN
}

export default async function handler(req, res) {
  if (!auth(req)) return res.status(401).json({ error: '인증 필요' })
  if (req.method !== 'POST') return res.status(405).end()

  const { newPassword } = req.body
  if (!newPassword) return res.status(400).json({ error: '새 비밀번호 입력 필요' })

  const { error } = await supabase
    .from('settings')
    .upsert({ key: 'admin:password_hash', value: sha256(newPassword) })
  if (error) return res.status(500).json({ error: error.message })
  res.status(200).json({ ok: true })
}
