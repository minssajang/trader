import { createHash } from 'crypto'
import { supabase } from '../../../lib/supabase'

function sha256(str) {
  return createHash('sha256').update(str).digest('hex')
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  const { password } = req.body
  if (!password) return res.status(400).json({ error: '비밀번호 입력 필요' })

  try {
    const { data } = await supabase
      .from('settings').select('value')
      .eq('key', 'admin:password_hash').single()

    const defaultHash = sha256(process.env.NEXT_PUBLIC_ADMIN_PASSWORD || 'admin1234')
    const validHash = data?.value ?? defaultHash

    if (sha256(password) !== validHash) {
      return res.status(401).json({ error: '비밀번호가 틀렸습니다' })
    }
    res.status(200).json({ token: process.env.ADMIN_SECRET_TOKEN })
  } catch {
    res.status(500).json({ error: '서버 오류' })
  }
}
