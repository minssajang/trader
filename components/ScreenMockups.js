import { useState } from 'react'

const SCREENS = [
  { key: 'trading', label: '거래' },
  { key: 'realtime', label: '실시간 연결' },
  { key: 'telegram', label: '📱 텔레그램 신호' },
  { key: 'sound', label: '🔊 사운드' },
  { key: 'replay', label: '🎬 리플레이' },
  { key: 'license', label: '🔑 라이선스' },
]

function Field({ label, value, placeholder }) {
  return (
    <div className="mk-row">
      <label>{label}</label>
      <div className={`mk-field${placeholder ? ' placeholder' : ''}`}>{value}</div>
    </div>
  )
}

function Check({ label, checked }) {
  return (
    <div className="mk-check">
      <span className={`box${checked ? ' checked' : ''}`} />
      {label}
    </div>
  )
}

function TradingScreen() {
  return (
    <>
      <div className="mk-group">
        <div className="mk-group-title">NinjaTrader 연동</div>
        <Field label="실행파일 경로" placeholder value="C:\Program Files\NinjaTrader 8\bin\NinjaTrader.exe" />
        <Field label="계좌" value="Sim101" />
        <div className="mk-btnrow">
          <span className="mk-chip accent">NinjaTrader 연결</span>
          <span className="mk-chip">연결 해제</span>
          <span className="mk-chip">🔁 재연결</span>
        </div>
        <div className="mk-status" style={{ marginTop: 10 }}><span className="dot" />상태: 연결됨 (NinjaTrader/Sim101)</div>
      </div>

      <div className="mk-grid2">
        <div className="mk-group">
          <div className="mk-group-title">📊 AI 추천 값</div>
          <Field label="보유금액 (USD)" value="10,000" />
          <Field label="리스크 (%)" value="1.0" />
          <Field label="손절 (포인트)" value="20" />
          <div className="mk-btnrow"><span className="mk-chip accent">AI 추천값 계산</span></div>
          <div className="mk-row" style={{ marginTop: 8 }}><label>추천 계약수</label><div className="mk-field">3</div></div>
        </div>
        <div className="mk-group">
          <div className="mk-group-title">매매 실행</div>
          <Field label="진입 계약수" value="3" />
          <Field label="손절 (포인트)" value="-$60.00 ←" />
          <Field label="익절 (포인트)" value="+$120.00 ←" />
          <div className="mk-btnrow">
            <span className="mk-chip sell">매도 (SELL)</span>
            <span className="mk-chip buy">매수 (BUY)</span>
          </div>
          <div className="mk-btnrow"><span className="mk-chip danger">🚨 벌크 청산</span></div>
        </div>
      </div>

      <div className="mk-group">
        <div className="mk-group-title">거래 로그</div>
        <div className="mk-log">
          <div>[09:31:02] NinjaTrader 브릿지 연결 성공 (Sim101)</div>
          <div>[09:31:15] 종목 ES 09-26 선택됨</div>
          <div className="muted-line">[09:32:40] 매수 주문 접수 · 3계약 @ 5820.25</div>
          <div className="muted-line">[09:34:11] 익절 체결 · +$118.50</div>
        </div>
      </div>
    </>
  )
}

function RealtimeScreen() {
  return (
    <>
      <div className="mk-group">
        <div className="mk-group-title">📡 실시간 데이터 연결</div>
        <div className="mk-status"><span className="dot" />● 연결됨 · 신호: 정상</div>
        <div className="mk-btnrow">
          <span className="mk-chip accent">연결 시작</span>
          <span className="mk-chip">전체 선택</span>
          <span className="mk-chip">전체 해제</span>
        </div>
      </div>

      <div className="mk-group">
        <div className="mk-group-title">분봉 선택</div>
        <div className="mk-btnrow" style={{ marginTop: 0 }}>
          <Check label="1분" checked />
          <Check label="3분" checked />
          <Check label="5분" />
          <Check label="15분" />
        </div>
      </div>

      <div className="mk-group">
        <div className="mk-group-title">실시간 데이터</div>
        <table className="mk-table">
          <thead><tr><th>시간</th><th>시가</th><th>고가</th><th>저가</th><th>종가</th></tr></thead>
          <tbody>
            <tr><td>09:41</td><td>5819.75</td><td>5822.00</td><td>5818.50</td><td>5821.25</td></tr>
            <tr><td>09:42</td><td>5821.25</td><td>5824.50</td><td>5820.75</td><td>5823.00</td></tr>
            <tr><td>09:43</td><td>5823.00</td><td>5825.25</td><td>5822.00</td><td>5824.75</td></tr>
          </tbody>
        </table>
      </div>
    </>
  )
}

function TelegramScreen() {
  return (
    <>
      <div className="mk-btnrow" style={{ marginTop: 0 }}>
        <span className="mk-chip accent">📊 전략 시뮬레이션 (1개월 백테스트)</span>
      </div>
      <div className="mk-group">
        <div className="mk-group-title">📱 텔레그램 알림 설정</div>
        <Field label="Bot Token" placeholder value="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz" />
        <Field label="Chat ID" placeholder value="123456789" />
        <div className="mk-btnrow">
          <span className="mk-chip accent">💾 저장</span>
          <span className="mk-chip">🔔 테스트 메시지</span>
        </div>
      </div>
      <div className="mk-group">
        <div className="mk-group-title">📡 매매 신호 알림</div>
        <div className="mk-row"><Check label="신호 발생 시 텔레그램으로 즉시 알림 전송" checked /></div>
      </div>
    </>
  )
}

function SoundScreen() {
  return (
    <>
      <div className="mk-group">
        <div className="mk-group-title">🔊 사운드 알림 설정</div>
        <Field label="종류" value="주문체결" />
        <Field label="프리셋" value="딩동" />
        <Field label="사운드" value="check-mark.mp3" />
        <div className="mk-btnrow">
          <span className="mk-chip">📂 파일 선택</span>
          <span className="mk-chip">▶ 미리듣기</span>
        </div>
      </div>
      <div className="mk-group">
        <div className="mk-group-title">이벤트별 사운드</div>
        <Field label="주문접수완료" value="ding-sound-effect_2.mp3" />
        <Field label="주문거절" value="wrong-answer-sound-effect.mp3" />
        <Field label="포지션정리" value="katog.mp3" />
        <div className="mk-btnrow"><span className="mk-chip accent">💾 설정 저장</span></div>
      </div>
    </>
  )
}

function ReplayScreen() {
  return (
    <>
      <div className="mk-group">
        <div className="mk-group-title">Market Replay</div>
        <div className="mk-status"><span className="dot" />상태: 리플레이 연결됨</div>
        <div className="mk-btnrow">
          <span className="mk-chip accent">① 리플레이 연결 (메뉴 열기+클릭)</span>
          <span className="mk-chip">① 리플레이 연결 해제</span>
        </div>
      </div>
      <div className="mk-group">
        <div className="mk-group-title">과거 데이터 창</div>
        <Field label="종목명(월물까지)" placeholder value="예: NQ 09-26" />
        <div className="mk-btnrow">
          <span className="mk-chip">② 종목 선택</span>
          <span className="mk-chip">③ 날짜 선택</span>
          <span className="mk-chip">④ 다운로드</span>
          <span className="mk-chip">⑤ 계속</span>
        </div>
      </div>
      <div className="mk-group">
        <div className="mk-group-title">다운로드 완료된 날짜</div>
        <table className="mk-table">
          <thead><tr><th>종목</th><th>다운로드된 날짜</th></tr></thead>
          <tbody>
            <tr><td>NQ 09-26</td><td>2026-06-01 ~ 2026-06-30</td></tr>
            <tr><td>ES 09-26</td><td>2026-05-15 ~ 2026-05-31</td></tr>
          </tbody>
        </table>
      </div>
    </>
  )
}

function LicenseScreen() {
  return (
    <div className="mk-group">
      <div className="mk-group-title">라이선스</div>
      <Field label="라이선스 키" placeholder value="이메일로 받은 라이선스 키를 입력하세요" />
      <div className="mk-btnrow"><span className="mk-chip accent">확인</span></div>
      <div className="mk-status" style={{ marginTop: 10 }}><span className="dot" />상태: 활성 (남은 기간 D-6)</div>
    </div>
  )
}

const SCREEN_CONTENT = {
  trading: TradingScreen,
  realtime: RealtimeScreen,
  telegram: TelegramScreen,
  sound: SoundScreen,
  replay: ReplayScreen,
  license: LicenseScreen,
}

export function ScreenMockups() {
  const [active, setActive] = useState('trading')
  const Content = SCREEN_CONTENT[active]

  return (
    <div>
      <div className="mk-shell">
        <div className="mk-titlebar">
          <span className="mk-dot red" />
          <span className="mk-dot yellow" />
          <span className="mk-dot green" />
          <span className="mk-titletext">EasyTrade For Ninja</span>
        </div>
        <div className="mk-tabbar">
          {SCREENS.map(s => (
            <button
              key={s.key}
              type="button"
              className={`mk-tab${active === s.key ? ' active' : ''}`}
              onClick={() => setActive(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="mk-body">
          <Content />
        </div>
      </div>
      <p className="mk-disclaimer">* 실제 화면을 단순화한 예시 이미지입니다</p>
    </div>
  )
}
