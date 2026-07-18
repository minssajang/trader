
// 마크다운 → HTML 변환 (블로그 본문 렌더링용)
// SVG, 테이블(raw HTML + 마크다운 파이프 문법), 이미지, 링크, 제목, 굵게, 기울임, 코드, 목록, 수평선 지원
// div/span/b/strong/em/u/mark 태그도 원본 그대로 통과 — 본문 중간에 색상·굵기 등 인라인 스타일 강조 삽입 가능

export function parseMarkdown(md) {
  if (!md) return ''

  // 0) 마크다운 파이프 표(| a | b |) → HTML <table> 변환
  //    구분선 행(|---|---|---|)을 헤더 다음 줄에서 감지해 표 블록으로 인식한다.
  let pre = md.replace(/((?:^\|.*\|[ \t]*\n)+)/gm, (tableBlock) => {
    const rawRows = tableBlock.replace(/\n$/, '').split('\n')
    const isSepRow = (row) => /^\|[\s:|-]+\|$/.test(row.trim())
    if (rawRows.length < 2 || !isSepRow(rawRows[1])) return tableBlock // 표 아님, 그대로 둠

    const rows = rawRows.filter((row, i) => i !== 1) // 구분선 제거
    let table = '<table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;">'
    rows.forEach((row, i) => {
      const cells = row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      const tag = i === 0 ? 'th' : 'td'
      const cellStyle = i === 0
        ? 'style="background:var(--card,#f3f4f6);padding:10px 14px;text-align:left;border:1px solid var(--border,#e5e7eb);font-weight:700;"'
        : 'style="padding:9px 14px;border:1px solid var(--border,#e5e7eb);"'
      table += '<tr>' + cells.map(c => `<${tag} ${cellStyle}>${c}</${tag}>`).join('') + '</tr>'
    })
    table += '</table>'
    return table + '\n'
  })

  // 1) raw HTML 블록(SVG, table, iframe, a — 쿠팡 배너/링크 코드 붙여넣기 대응 / div, span, b, strong, em, u, mark — 색상·굵기 등 인라인 스타일 강조용) 보호 — 이스케이프 전에 먼저 추출
  const blocks = []
  let src = pre.replace(/<(svg|table|iframe|a|div|span|b|strong|em|u|mark)[\s\S]*?<\/\1>/gi, (match) => {
    blocks.push(match)
    return `\x00BLOCK${blocks.length - 1}\x00`
  })

  // 2) 특수문자 이스케이프 (보호된 블록 제외)
  src = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // 3) 이미지 (링크보다 먼저)
  src = src.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px;margin:12px 0;display:block;" />')

  // 4) 링크
  src = src.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:var(--accent);text-decoration:underline;">$1</a>')

  // 5) 제목
  src = src
    .replace(/^#### (.+)$/gm, '<h4 style="font-size:16px;font-weight:800;margin:24px 0 8px;">$1</h4>')
    .replace(/^### (.+)$/gm,  '<h3 style="font-size:18px;font-weight:800;margin:28px 0 10px;">$1</h3>')
    .replace(/^## (.+)$/gm,   '<h2 style="font-size:21px;font-weight:900;margin:36px 0 12px;color:var(--text);">$1</h2>')
    .replace(/^# (.+)$/gm,    '<h1 style="font-size:26px;font-weight:900;margin:40px 0 16px;">$1</h1>')

  // 6) 굵게 / 기울임 / 인라인 코드
  src = src
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code style="background:var(--card,#f3f4f6);padding:2px 6px;border-radius:4px;font-size:0.9em;">$1</code>')

  // 7) 수평선
  src = src.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--border,#e5e7eb);margin:28px 0;" />')

  // 8) 순서있는 목록
  src = src.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => l.replace(/^\d+\. /, '').trim())
    return '<ol style="padding-left:1.5em;margin:12px 0;">' + items.map(i => `<li style="margin-bottom:6px;">${i}</li>`).join('') + '</ol>\n'
  })

  // 9) 순서없는 목록
  src = src.replace(/((?:^[ \t]*[-*] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => l.replace(/^[ \t]*[-*] /, '').trim())
    return '<ul style="padding-left:1.5em;margin:12px 0;">' + items.map(i => `<li style="margin-bottom:6px;">${i}</li>`).join('') + '</ul>\n'
  })

  // 10) 단락 처리 — 빈 줄로 구분, 이미 HTML 태그로 시작하는 줄은 건드리지 않음
  const lines = src.split(/\n{2,}/)
  src = lines.map(block => {
    block = block.trim()
    if (!block) return ''
    if (/^\x00BLOCK/.test(block)) return block  // 보호된 블록
    if (/^<(h[1-6]|ul|ol|li|hr|img|a |p |div|blockquote)/.test(block)) return block
    // 단락 내 개행 → <br>
    return `<p style="margin-bottom:1.2em;line-height:1.85;">${block.replace(/\n/g, '<br />')}</p>`
  }).join('\n')

  // 11) 보호된 블록 복원
  src = src.replace(/\x00BLOCK(\d+)\x00/g, (_, i) => blocks[parseInt(i)])

  return src
}
