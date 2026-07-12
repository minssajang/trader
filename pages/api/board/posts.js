import { supabase } from '../../../lib/supabase'
import { randomUUID } from 'crypto'
import { createHash } from 'crypto'

function sha256(str) {
  return createHash('sha256').update(str).digest('hex')
}

function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00')
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const { limit = 20, offset = 0 } = req.query
    const { data, error } = await supabase
      .from('blog_posts')
      .select('id, title, author_name, is_secret, created_at')
      .eq('post_type', 'free')
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data || [])
  }

  if (req.method === 'POST') {
    const { title, author_name, password, content, is_secret } = req.body
    if (!title || !title.trim()) return res.status(400).json({ error: '제목을 입력해주세요' })
    if (!content || !content.trim()) return res.status(400).json({ error: '내용을 입력해주세요' })
    if (!password || password.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상 입력해주세요' })

    const now = nowKST()
    const id = randomUUID()
    const { data, error } = await supabase.from('blog_posts').insert([{
      id,
      post_type: 'free',
      title: title.trim(),
      slug: id,
      author_name: (author_name || '익명').trim() || '익명',
      password_hash: sha256(password),
      content,
      is_secret: !!is_secret,
      status: 'published',
      category: null,
      published_at: now,
      created_at: now,
      updated_at: now,
    }]).select('id, title, author_name, is_secret, created_at').single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  res.status(405).end()
}
