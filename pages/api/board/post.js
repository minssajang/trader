import { supabase } from '../../../lib/supabase'
import { createHash } from 'crypto'

function sha256(str) {
  return createHash('sha256').update(str).digest('hex')
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { id, password, action } = req.body
  if (!id) return res.status(400).json({ error: 'id 필요' })

  const { data: post, error } = await supabase
    .from('blog_posts')
    .select('id, title, author_name, content, is_secret, password_hash, created_at')
    .eq('id', id)
    .eq('post_type', 'free')
    .single()

  if (error || !post) return res.status(404).json({ error: '글을 찾을 수 없습니다' })

  if (post.is_secret) {
    if (!password) return res.status(401).json({ error: '비밀번호를 입력해주세요', needPassword: true })
    if (sha256(password) !== post.password_hash) {
      return res.status(401).json({ error: '비밀번호가 일치하지 않습니다' })
    }
  }

  if (action === 'delete') {
    if (!password) return res.status(401).json({ error: '비밀번호를 입력해주세요' })
    if (sha256(password) !== post.password_hash) {
      return res.status(401).json({ error: '비밀번호가 일치하지 않습니다' })
    }
    const { error: delErr } = await supabase.from('blog_posts').delete().eq('id', id)
    if (delErr) return res.status(500).json({ error: delErr.message })
    return res.status(200).json({ ok: true })
  }

  const { password_hash, ...safePost } = post
  return res.status(200).json(safePost)
}
