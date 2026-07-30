
import { useState } from 'react'

// 골드/나스닥 백테스팅 데이터의 "어느 날짜에 데이터가 있는지" 보여주는 달력.
// 라이브 재생 페이지(backtest-chart.js)와 admin 업로드 패널(BacktestDataPanel.js)이 같이 쓴다.
const WEEKDAY_LABEL = ['일', '월', '화', '수', '목', '금', '토']

// "YYYY-MM-DD" 문자열 그대로 하루씩 이동 (로컬 타임존 기준 - candleCsv.js의 toLocalDateStr과 짝을 맞춤)
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

// 데이터셋들의 date_from~date_to 구간을 모두 합쳐 "데이터가 있는 날짜" 집합을 만든다.
// (실제 캔들이 없는 주말도 포함될 수 있지만, 그런 날은 선택해도 "캔들 없음"으로 자연스럽게 처리됨)
export function buildAvailableDates(datasets) {
  const set = new Set()
  for (const ds of datasets) {
    if (!ds.date_from || !ds.date_to) continue
    let cur = ds.date_from
    let guard = 0
    while (cur <= ds.date_to && guard < 3660) {
      set.add(cur)
      cur = addDays(cur, 1)
      guard++
    }
  }
  return set
}

// 데이터가 있는 가장 최근 날짜가 속한 달을 기본으로 보여줄 때 씀
export function latestMonth(datasets) {
  const latest = datasets.reduce((max, r) => (r.date_to && r.date_to > max ? r.date_to : max), '')
  if (!latest) return null
  const [y, m] = latest.split('-').map(Number)
  return new Date(y, m - 1, 1)
}

// 달력/볼린저 리스트처럼 왼쪽 컬럼에 세로로 쌓이는 카드들을 접었다 펼 수 있게 하는 공용 껍데기.
export function CollapsibleCard({ title, defaultOpen = true, maxWidth = 170, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: open ? 12 : '10px 12px', maxWidth }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          background: 'none', border: 'none', color: '#9aa0ab', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: 0,
          fontSize: 11, fontWeight: 700, marginBottom: open ? 8 : 0,
        }}
      >
        <span>{title}</span>
        <span style={{ fontSize: 10 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && children}
    </div>
  )
}

// 텍스트 글자(‹ ›)는 폰트마다 글리프 자체가 박스 중앙에 딱 오지 않아서 살짝 위/아래로 치우쳐 보이는
// 문제가 있었다 - 폰트에 의존하지 않도록 SVG로 직접 그려서 항상 버튼 정중앙에 오게 한다.
function Chevron({ direction }) {
  const points = direction === 'left' ? '15 6 9 12 15 18' : '9 6 15 12 9 18'
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ display: 'block' }}>
      <polyline points={points} stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// onSelect를 안 넘기면 클릭 불가능한 읽기 전용 달력(admin의 "빈 날짜 확인용")으로 동작한다.
// bare=true면 카드 껍데기(배경/테두리/패딩) 없이 내용만 렌더링 - CollapsibleCard 안에 넣을 때 씀.
// selectedDateTo를 같이 넘기면 selectedDate~selectedDateTo 구간 전체를 옅게 하이라이트한다(범위 선택 표시용).
// onSelect는 (dateStr, shiftKey)로 호출된다 - Shift+클릭인지 호출하는 쪽에서 구분해서 범위 선택에 쓸 수 있게.
export function MonthCalendar({ viewDate, onNavigate, availableDates, selectedDate, selectedDateTo, onSelect, maxWidth = 340, bare = false }) {
  const year = viewDate.getFullYear()
  const month = viewDate.getMonth()
  const startWeekday = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  // 1일 이전 빈칸을 그냥 비워두면, 달 경계를 넘는 범위(예: 7월 29일~8월 2일)를 선택할 때 이전/다음 달로
  // 갔다가 다시 돌아와야 하는 불편이 있었다(사용자 지적) - 그 칸에 실제 이전 달 날짜를 흐리게 채워서
  // 데이터가 있으면 그 자리에서 바로 클릭할 수 있게 한다. new Date(y, -1, d)는 자동으로 전년도 12월로
  // 넘어가므로 month가 0(1월)이어도 별도 분기 없이 그대로 계산된다.
  const cells = []
  const prevMonthLastDay = new Date(year, month, 0).getDate()
  for (let i = 0; i < startWeekday; i++) {
    const day = prevMonthLastDay - startWeekday + 1 + i
    const dt = new Date(year, month - 1, day)
    const dateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
    cells.push({ day, dateStr, otherMonth: true })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    cells.push({ day: d, dateStr, otherMonth: false })
  }

  const navBtn = {
    background: 'none', border: '1px solid #2a2e38', color: '#9aa0ab', borderRadius: 8,
    width: 30, height: 30, cursor: 'pointer', padding: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  }

  const wrapperStyle = bare ? {} : { background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 16, maxWidth }

  // 범위 하이라이트 - selectedDateTo가 없으면(단일 선택) rangeFrom===rangeTo===selectedDate라 아무 날짜도 "구간 내부"로 안 잡힘
  const rangeFrom = selectedDateTo ? (selectedDate <= selectedDateTo ? selectedDate : selectedDateTo) : selectedDate
  const rangeTo = selectedDateTo ? (selectedDate <= selectedDateTo ? selectedDateTo : selectedDate) : selectedDate

  return (
    <div style={wrapperStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <button type="button" onClick={() => onNavigate(-1)} style={navBtn}><Chevron direction="left" /></button>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{year}년 {month + 1}월</div>
        <button type="button" onClick={() => onNavigate(1)} style={navBtn}><Chevron direction="right" /></button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4, fontSize: 11, color: '#9aa0ab', textAlign: 'center', marginBottom: 4 }}>
        {WEEKDAY_LABEL.map(w => <div key={w}>{w}</div>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
        {cells.map(({ day, dateStr, otherMonth }, i) => {
          const has = availableDates.has(dateStr)
          const isEndpoint = dateStr === selectedDate || dateStr === selectedDateTo
          const inRange = !!selectedDateTo && dateStr > rangeFrom && dateStr < rangeTo
          const clickable = has && !!onSelect
          return (
            <button
              type="button"
              key={i}
              disabled={!clickable}
              onClick={clickable ? (e) => onSelect(dateStr, e.shiftKey) : undefined}
              title={clickable ? 'Shift+클릭하면 지금까지 선택된 날짜부터 여기까지 이어서 불러옵니다' : undefined}
              style={{
                padding: '8px 0', borderRadius: 6, fontSize: 12,
                cursor: clickable ? 'pointer' : 'default',
                opacity: otherMonth ? 0.4 : 1,
                border: isEndpoint ? '1px solid #4CAF50' : '1px solid transparent',
                background: isEndpoint ? '#4CAF50' : inRange ? 'rgba(76,175,80,0.4)' : has ? 'rgba(76,175,80,0.15)' : 'transparent',
                color: isEndpoint ? '#fff' : has ? '#e8eaed' : '#3a3f4a',
                fontWeight: has ? 700 : 400,
              }}
            >{day}</button>
          )
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: 11, color: '#9aa0ab' }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: 'rgba(76,175,80,0.15)', display: 'inline-block' }} />
        데이터 있음
      </div>
    </div>
  )
}
