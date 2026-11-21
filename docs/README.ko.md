# Antigravity Suite

[简体中文](../README.md) · [English](README.en.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md)

> **Google Antigravity 데스크톱(macOS)을 위한 100% 무변조(Zero-Patch) 올인원 확장 및 원격 제어 스위트입니다. `app.asar`와 Apple 공식 서명을 건드리지 않으며 공식 업데이트를 방해하지 않습니다.**

## 핵심 기능

1. **🇨🇳 중국어/영어 즉시 전환 (제로 토큰 사고 번역)**: 로컬 캐시를 통해 토큰 소모 없이 사고 과정과 제목을 번역하며, **`⚙️`** 설정에서 재시작 없이 영어 원판 UI로 즉시 전환할 수 있습니다.
2. **📱 초고속 모바일·PC 원격 제어 (공식 대비 압도적 속도)**:
   - 공식 클라우드 중계 없이 LAN 밀리초 직결 및 Tailscale(HTTPS 인증서 활성화 시 `tailscale serve`를 자동 구성해 `https://<host>.ts.net`를 우선 제공하고 PWA '안전하지 않음' 경고 및 HTTP 다운그레이드 차단) / Bonjour / 로그인 없는 Cloudflare 임시 터널 중 최단 경로를 자동 선택하며, 대화 전환 시 이전 화면의 미완료 데이터 불러오기만 취소(백그라운드 AI 실행은 중단하지 않음)·지연 이력 로딩·`gzip` 압축이 적용된 초경량 PWA로 즉시 열립니다.
   - 멀티 프로젝트 전환(읽지 않음/승인 배지), 무의존 **Web Push 백그라운드 알림**(완료·승인 대기 + 로컬 알림 폴백) 및 **PWA 앱 아이콘 읽지 않음 배지**(완료 후 미열람 대화만 엄격 집계), 무손실 전체 기록 스크롤, `$HOME` 안전 경계 내 원격 프로젝트 생성 및 파일 트리·변경 diff 미리보기, 입력창 상단 **가로 스크롤 단축 명령 바**(데스크톱과 동기화·**`⚡즉시 전송 / ✎입력`** 원클릭 전환·초안 보호 지원), 대기열 메시지 관리(즉시 전송/철회), 일반 파일·이미지 업로드, 대화형 확인 카드(고위험 2단계 확인), 상단 드로어, 9개 화면 토글, 탭별 세션 격리 및 IME 오입력 방지 `Cmd/Ctrl + Enter` 전송을 지원합니다.
3. **⚡ 입력창 단축 명령 & 프롬프트 최적화 (`입력` vs `⚡즉시 전송`)**：
   - 14종 내장 추천 명령 풀(네이티브 알약 자동 변환)과 사용자 영역 **인기 템플릿 10종 원클릭 추가**.
   - **`입력`** 은 입력창에만 배치(오류·맥락 첨부용), **`⚡즉시 전송`**(`↵`)은 클릭 즉시 전송(`바로 구현`·`중국어로 답변` 등 8종). 초안 보호·**`⌘/Ctrl + 클릭`** 반전, **`✨ 최적화` / `↩ 되돌리기`**, **`Tab / →`** 문맥 추천을 제공합니다.
4. **🧰 데스크톱 편의 도구**：**`⌘1`~`⌘9`** 대화 즉시 전환, 플로팅 메시지 내비게이션, **`✏️ 편집` + `⌘S`** 인라인 파일 저장 및 **`>_ CLI`** 터미널 실행(`v2.32.x–2.34.0` / `SingletonSocket` / 비 Homebrew Node 자동 탐색 지원).
5. **📊 컨텍스트 및 듀얼 할당량 모니터 (240K 자동 압축 & 328K 캐시 이탈 경고)**：상단 링으로 현재 컨텍스트 점유율·52주 히트맵·API 참고 비용을 보고 `G4` / `C` 캡슐로 5시간 및 주간 잔여 한도를 추적합니다. 유휴 상태 240K 도달 또는 캐시 0% 이탈 시 `/compact`를 자동 실행해 장시간 지연을 방지합니다.
6. **🛡️ 위험 명령 빨간 테두리 차단**：`rm -rf`·`git reset --hard`·`sudo` 등 고위험 명령 실행 전에는 자동 승인이 켜져 있어도 빨간 경고창으로 반드시 사용자 확인을 요구합니다.
7. **🔄 업데이트 자동 감지 & 원클릭 핫 업데이트**：새 버전이 감지되면 우측 상단 **`⚙️`** 에 빨간 점이 표시되며 클릭 한 번으로 재시작 없이 즉시 적용됩니다.

---

## 🚀 빠른 설치 (macOS · 무변조 CDP 방식)

필요 환경: **macOS**, **Google Antigravity**, **Node.js `22.4.0+`**

```bash
git clone https://github.com/iamvicliu/antigravity-suite.git ~/.local/share/antigravity-suite
cd ~/.local/share/antigravity-suite
./scripts/setup-macos-cdp.sh
```

> 선택 옵션: `--no-auto`(자동 실행 제외, `ag-context-meter install-launcher`로 독립 실행 아이콘 생성 가능), `--no-remote`(원격 서버 비활성화). Windows / Linux에서는 원격 디버깅 포트로 실행한 뒤 `node cli.js live`를 실행하세요.

### 일상 명령어

- `ag-context-meter status`: 모듈 활성 상태 및 공식 `app.asar` 무결성 확인
- `ag-context-meter remote`: 4채널 QR 코드 및 연결된 기기 확인 (`--tunnel on|off` / `--reset-token`)
- `ag-context-meter live` / `restart`: 현재 창 즉시 적용 또는 `v2.33.0+` 디버깅 포트 포함 재실행
- `ag-context-meter update` / `stop` / `auto-off`: 최신 버전 핫 업데이트, 일시 중지, 자동 실행 끄기

테스트는 `npm run test:suite`로 실행할 수 있습니다. QR 페어링·원격 제어 및 사용 경험 최적화에 기여한 공동 기여자 [@hubo1989](https://github.com/hubo1989) · [@Shens](https://github.com/Shens) 님께 감사드립니다. 자세한 내용은 **[简体中文 README](../README.md)** 및 **[English README](README.en.md)** 를 참고하세요. [MIT License](../LICENSE) 라이선스를 따릅니다.
