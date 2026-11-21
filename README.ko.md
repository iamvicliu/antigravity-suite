# Antigravity Suite

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md)

> **Google Antigravity 데스크톱(macOS)을 위한 100% 무변조(Zero-Patch) 올인원 확장 및 원격 제어 스위트입니다. `app.asar`와 Apple 공식 서명을 건드리지 않으며 공식 업데이트를 방해하지 않습니다.**

## 핵심 기능

1. **🇨🇳 중국어/영어 즉시 전환 (제로 토큰 사고 번역)**：로컬 캐시를 통해 토큰 소모 없이 사고 과정과 제목을 번역하며, **`⚙️`** 설정에서 재시작 없이 영어 원판 UI로 즉시 전환할 수 있습니다.
2. **📱 4채널 모바일·PC 원격 제어 (무료 Cloudflare 터널 기본 탑재 & 멀티 세션 격리)**：LAN / Tailscale / Bonjour / 로그인 없는 Cloudflare 임시 터널(기본 활성, 자체 고정 도메인 지원)로 어디서나 대화, 이미지 전송, 도구 승인을 처리합니다. 자동 최단 경로 전환, 멀티 프로젝트 전환 및 `$HOME` 안전 경계 내 원격 폴더 프로젝트 생성, 상단 컨텍스트/사용량 패널, 9개 화면 표시 토글, 브라우저 탭별 독립 세션 및 IME 오입력 방지 `Cmd/Ctrl + Enter` 전송을 지원합니다.
3. **📊 컨텍스트 및 듀얼 할당량 모니터 (240K 자동 압축 & 328K 캐시 이탈 경고)**：상단 링으로 현재 컨텍스트 점유율·52주 히트맵·API 참고 비용을 보고 `G4` / `C` 캡슐로 5시간 및 주간 잔여 한도를 추적합니다. 또한 유휴 상태 240K 도달 또는 캐시 0% 이탈 시 `/compact`를 자동 실행해 장시간 지연을 방지합니다.
4. **⚡ 입력창 생산성 스위트**：14종 내장 추천 명령 풀(시나리오별 그룹 정렬·2줄 호버 툴팁·슬래시 선택 시 네이티브 알약 자동 변환) + 사용자 프롬프트, 전송 버튼 옆 **`✨ 최적화` / `↩ 되돌리기`**, `Tab` 다음 질문 미리보기, **`⌘1`~`⌘9`** 대화 빠른 전환, **`⌘S`** 인라인 파일 편집 및 **`>_ CLI`** 실행을 제공합니다.
5. **🛡️ 위험 명령 빨간 테두리 차단**：`rm -rf`·`git reset --hard`·`sudo` 등 고위험 명령 실행 전에는 자동 승인이 켜져 있어도 빨간 경고창으로 반드시 사용자 확인을 요구합니다.
6. **🔄 업데이트 자동 감지 & 원클릭 핫 업데이트**：새 버전이 감지되면 우측 상단 **`⚙️`** 에 빨간 점이 표시되며 클릭 한 번으로 재시작 없이 즉시 적용됩니다.

---

## 🚀 빠른 설치 (macOS · 무변조 CDP 방식)

필요 환경: **macOS**, **Google Antigravity**, **Node.js `22.4.0+`**

```bash
git clone https://github.com/iamvicliu/antigravity-suite.git ~/.local/share/antigravity-context-viewer
cd ~/.local/share/antigravity-context-viewer
./scripts/setup-macos-cdp.sh
```

> 선택 옵션: `--no-auto`(자동 실행 제외, `ag-context-meter install-launcher`로 독립 실행 아이콘 생성 가능), `--no-remote`(원격 서버 비활성화). Windows / Linux에서는 원격 디버깅 포트로 실행한 뒤 `node cli.js live`를 실행하세요.

### 일상 명령어

- `ag-context-meter status`: 모듈 활성 상태 및 공식 `app.asar` 무결성 확인
- `ag-context-meter remote`: 4채널 QR 코드 및 연결된 기기 확인 (`--tunnel on|off` / `--reset-token`)
- `ag-context-meter live` / `restart`: 현재 창 즉시 적용 또는 `v2.33.0+` 디버깅 포트 포함 재실행
- `ag-context-meter update` / `stop` / `auto-off`: 최신 버전 핫 업데이트, 일시 중지, 자동 실행 끄기

테스트는 `npm run test:suite`로 실행할 수 있습니다. 자세한 사용법·문제 해결·오픈소스 감사는 **[简体中文 README](README.md)** 및 **[English README](README.en.md)** 를 참고하세요. [MIT License](LICENSE) 라이선스를 따릅니다.
