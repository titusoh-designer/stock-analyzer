# Stock Pattern Analyzer — 배포 가이드

## 3분이면 끝나는 Vercel 배포

### 1단계: GitHub에 올리기
1. https://github.com/new 에서 새 저장소 생성 (이름: `stock-analyzer`)
2. 이 폴더의 파일들을 모두 업로드:
   ```
   stock-app/
   ├── api/
   │   └── stock.js      ← 서버리스 API (Yahoo/네이버/CoinGecko 프록시)
   ├── public/
   │   └── index.html     ← 프론트엔드 (차트 + 패턴 분석 UI)
   ├── package.json
   ├── vercel.json
   └── README.md
   ```

### 2단계: Vercel에 배포
1. https://vercel.com 접속 → GitHub 계정으로 로그인
2. "Add New Project" 클릭
3. 방금 만든 `stock-analyzer` 저장소 선택
4. 설정 변경 없이 "Deploy" 클릭
5. 1분 후 배포 완료 → `https://stock-analyzer-xxxxx.vercel.app` 주소 생성

### 끝!

---

## 사용법

| 기능 | 방법 |
|---|---|
| 미국 주식 | 티커 입력 (AAPL, TSLA, NVDA) + Yahoo 선택 |
| 한국 주식 | 종목코드 입력 (005930, 035720) + 네이버 선택 |
| 암호화폐 | 코인ID 입력 (bitcoin, ethereum) + Crypto 선택 |
| 타임프레임 | 1시간 / 일봉 / 주봉 / 월봉 버튼 전환 |

## API 라우트

```
GET /api/stock?symbol=AAPL&source=yahoo&interval=1d
GET /api/stock?symbol=005930&source=naver&interval=1d
GET /api/stock?symbol=bitcoin&source=coingecko&interval=1d
```

## 데이터 소스

| 소스 | 커버리지 | API 키 | 제한 |
|---|---|---|---|
| Yahoo Finance | 미국/글로벌 주식 | 불필요 | 없음 |
| 네이버 금융 | 한국 주식 (KRX) | 불필요 | 없음 |
| CoinGecko | 암호화폐 | 불필요 | 분당 30회 |

**모든 소스가 무료이고 API 키가 필요 없습니다.**

## 구조

```
[사용자 브라우저]
    ↓ fetch("/api/stock?symbol=AAPL")
[Vercel 서버리스 함수] ← CORS 문제 없음
    ↓ fetch("https://query1.finance.yahoo.com/...")
[Yahoo Finance / 네이버 / CoinGecko]
    ↓ 실제 JSON 데이터
[Vercel 서버리스 함수]
    ↓ 파싱된 OHLCV 데이터
[사용자 브라우저]
    ↓ SVG 차트 렌더링
    ↓ Claude API로 패턴 분석 (선택)
```
