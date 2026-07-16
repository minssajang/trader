import { OAuth2Client } from 'google-auth-library'

async function getAccessToken() {
  const client = new OAuth2Client(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET)
  client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN })
  const { token } = await client.getAccessToken()
  if (!token) throw new Error('유튜브 access token 발급 실패')
  return token
}

const MAX_MB = 500

export default async function handler(req, res) {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ error: '인증 필요' })
  }
  if (req.method !== 'POST') return res.status(405).end()

  const { title, description, contentType, fileSize } = req.body || {}
  if (!contentType || !fileSize) return res.status(400).json({ error: 'contentType/fileSize 필요' })
  if (!contentType.startsWith('video/')) {
    return res.status(400).json({ error: '동영상 파일만 업로드할 수 있습니다.' })
  }
  if (fileSize > MAX_MB * 1024 * 1024) {
    return res.status(400).json({ error: `${MAX_MB}MB 이하 파일만 업로드할 수 있습니다.` })
  }

  try {
    const accessToken = await getAccessToken()
    const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': contentType,
        'X-Upload-Content-Length': String(fileSize),
      },
      body: JSON.stringify({
        snippet: { title: title || '매매 시스템 블로그 영상', description: description || '' },
        status: { privacyStatus: 'unlisted' },
      }),
    })
    if (!initRes.ok) {
      const errText = await initRes.text()
      return res.status(500).json({ error: `유튜브 업로드 세션 생성 실패: ${errText}` })
    }
    const uploadUrl = initRes.headers.get('location')
    if (!uploadUrl) return res.status(500).json({ error: '유튜브 업로드 URL을 받지 못했습니다.' })
    return res.status(200).json({ uploadUrl })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
