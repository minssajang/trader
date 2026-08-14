// 캔들 CSV 파싱 유틸 — 두 가지 소스를 모두 받아준다.
//   1) MT5 히스토리센터에서 수동 내보내기(탭 구분, <DATE> <TIME> <OPEN> <HIGH> <LOW> <CLOSE> ...)
//   2) 우리 다운로더 스크립트가 저장한 CSV(콤마 구분, time,open,high,low,close,...)
// 컬럼 순서가 달라도 헤더 이름으로 찾고, 한글 헤더(시가/고가/저가/종가/시간/날짜)도 인식한다.

const HEADER_ALIASES = {
  date: ['date', '<date>', '날짜'],
  time: ['time', '<time>', '시간', 'datetime', '일시'],
  open: ['open', '<open>', '시가'],
  high: ['high', '<high>', '고가'],
  low: ['low', '<low>', '저가'],
  close: ['close', '<close>', '종가'],
}

// MT5 CSV의 시간은 브로커 서버시간이고 시간대 표기가 전혀 없다. 2026-07(서머타임 기간) 데이터로
// 직접 확인한 결과 브로커 01시 = 실제 한국시간(KST) 07시 — 즉 브로커가 한국시간보다 6시간 느리다(UTC+3, EEST 추정).
// 브로커가 서머타임을 쓰는 곳이라 겨울엔 서버시간이 1시간 뒤로 밀려(EET, UTC+2) 오프셋이 7시간으로 바뀐다.
// 그래서 자동판별 대신 페이지의 서머타임 토글 버튼으로 호출 쪽에서 오프셋을 넘겨주게 했다 - 기본값은 서머타임(6시간).
export const BROKER_OFFSET_SECONDS = { summer: 6 * 3600, winter: 7 * 3600 }

function detectDelimiter(headerLine) {
  return headerLine.includes('\t') ? '\t' : ','
}

function findColumn(headers, key) {
  const aliases = HEADER_ALIASES[key]
  return headers.findIndex(h => aliases.includes(h.trim().toLowerCase()))
}

// "2026.01.02" + "09:00:00" 또는 "2026-01-02 09:00:00" 등을 초단위 타임스탬프로.
// 시간대 표기가 없는 문자열이라 일단 로컬 타임존으로 해석한 뒤, 브로커→한국시간 오프셋을 더한다
// (dateFrom/dateTo도 이 값을 그대로 쓰는 toLocalDateStr을 거치므로 자정 근처 캔들이 하루 밀리지 않는다).
// 라이브 페이지도 MT5 EA가 보낸 브로커 원본 날짜/시각 문자열을 똑같이 이 함수로 변환해야
// 히스토리 CSV와 시간축이 어긋나지 않는다 - MQL5 datetime의 epoch 계산 기준(UTC로 가정)과
// 이 함수의 기준(로컬 타임존으로 가정)이 달라서, EA가 만약 자체 계산한 epoch 숫자를 보내면
// 몇 시간씩 밀려 보이는 문제가 생긴다. 그래서 export해서 라이브 쪽도 같은 변환을 거치게 한다.
export function toUnixSeconds(dateStr, timeStr, offsetSeconds) {
  const d = (dateStr || '').trim().replace(/\./g, '-')
  const t = (timeStr || '00:00:00').trim()
  const iso = timeStr ? `${d}T${t}` : d
  const ms = Date.parse(iso.includes('T') || !dateStr.includes(' ') ? iso : dateStr)
  if (!Number.isNaN(ms)) return Math.floor(ms / 1000) + offsetSeconds
  const ms2 = Date.parse(`${d} ${t}`)
  return Number.isNaN(ms2) ? null : Math.floor(ms2 / 1000) + offsetSeconds
}

// toUnixSeconds가 로컬 타임존(+브로커 오프셋)으로 해석하므로, 요약용 날짜 문자열도 반드시
// 로컬 getter(getFullYear/getMonth/getDate)로 뽑아야 한다.
// (toISOString()은 UTC 기준이라 한국(UTC+9)처럼 로컬이 UTC보다 앞서면
//  자정 근처 캔들의 날짜가 하루 당겨져 보이는 버그가 있었음)
// 캘린더에서 "이 날짜에 어떤 캔들이 속하는지" 묶을 때도 같은 기준을 써야 하므로 export한다.
export function toLocalDateStr(unixSeconds) {
  const d = new Date(unixSeconds * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function parseCandleCsv(text, offsetSeconds = BROKER_OFFSET_SECONDS.summer) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length < 2) throw new Error('CSV에 데이터가 없습니다')

  const delimiter = detectDelimiter(lines[0])
  const headers = lines[0].split(delimiter).map(h => h.trim())

  const dateIdx = findColumn(headers, 'date')
  const timeIdx = findColumn(headers, 'time')
  const openIdx = findColumn(headers, 'open')
  const highIdx = findColumn(headers, 'high')
  const lowIdx = findColumn(headers, 'low')
  const closeIdx = findColumn(headers, 'close')

  if (openIdx < 0 || highIdx < 0 || lowIdx < 0 || closeIdx < 0 || (dateIdx < 0 && timeIdx < 0)) {
    throw new Error('CSV 헤더에서 시가/고가/저가/종가/시간 컬럼을 찾을 수 없습니다')
  }

  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delimiter)
    if (cols.length < headers.length) continue

    const dateStr = dateIdx >= 0 ? cols[dateIdx] : ''
    // date/time이 한 컬럼(예: "2026-01-02 09:00:00")에 같이 들어있는 경우도 처리
    const timeStr = timeIdx >= 0 ? cols[timeIdx] : ''
    const combined = dateIdx >= 0 && timeIdx >= 0 && !cols[timeIdx].includes('-')
      ? { d: dateStr, t: timeStr }
      : { d: dateStr || timeStr, t: dateStr ? timeStr : '' }

    const time = toUnixSeconds(combined.d, combined.t, offsetSeconds)
    const open = parseFloat(cols[openIdx])
    const high = parseFloat(cols[highIdx])
    const low = parseFloat(cols[lowIdx])
    const close = parseFloat(cols[closeIdx])
    if (time == null || [open, high, low, close].some(Number.isNaN)) continue

    rows.push({ time, open, high, low, close })
  }

  rows.sort((a, b) => a.time - b.time)
  if (rows.length === 0) throw new Error('유효한 캔들 행을 찾지 못했습니다')

  return {
    rows,
    dateFrom: toLocalDateStr(rows[0].time),
    dateTo: toLocalDateStr(rows[rows.length - 1].time),
  }
}
