# PiQuest

PiQuest는 Pi(`pi-mono` 모노레포)를 기반으로 하는 게임 개발 전용 코딩 에이전트입니다. Pi를 다시 작성하거나 범용 에이전트 프레임워크를 처음부터 만드는 것이 목표가 아닙니다. 업스트림 Pi의 에이전트, 모델/프로바이더, 세션, 도구, TUI 인프라를 최대한 보존하면서 그 위에 게임 개발 특화 동작을 얹는 것이 목표입니다.

현재 저장소는 업스트림 Pi(v0.84.2)를 그대로 추적합니다. 업스트림과의 병합성을 최우선으로 유지하며, PiQuest 전용 코드는 PiQuest 소유 패키지에 격리합니다.

## 상태

기반 구축 단계입니다. 저장소는 순수 업스트림 Pi 클론이며 `AGENTS.md`에 PiQuest 개발 규칙이 정리되어 있습니다. 게임 개발 기능은 아직 구현되지 않았습니다.

## 아키텍처

업스트림과의 병합성 수준에 따라 세 계층으로 나뉩니다.

- **업스트림 소유 패키지**(`packages/agent`, `packages/ai`, `packages/tui`, `packages/client`, `packages/protocol`, `packages/server`, `packages/session-backends`, `packages/telemetry`, `packages/evals`): 가능한 한 업스트림과 동일하게 유지합니다.
- **`packages/coding-agent`**: 주요 Pi 통합 지점입니다. 프로그래매틱 SDK, 세션 API, 확장 API, 도구 팩토리, 프레젠테이션 훅을 제공합니다.
- **PiQuest 소유 코드**: `packages/piquest/`에 위치합니다. `piquest` CLI 진입점, 브랜딩/프레젠테이션, 프로젝트/게임 컨텍스트, 엔진 감지 및 어댑터, 게임 전용 도구, 실행/플레이테스트/검증 워크플로우를 담당합니다.

엔진 특화 기능은 명시적인 엔진 어댑터 경계 뒤에 구현됩니다. 첫 번째 엔진 타겟은 Unity이며, 섣부른 다중 엔진 지원은 하지 않습니다.

## 개발

```bash
npm install --ignore-scripts  # 라이프사이클 스크립트 없이 의존성 설치
npm run check         # 린트, 포맷, 타입체크, 의존성 검사
./test.sh             # API 키 없이 테스트 실행
./pi-test.sh          # 소스에서 에이전트 실행
```

자세한 개발 규칙(아키텍처 경계, 업스트림 정책, 커맨드, 테스트)은 `AGENTS.md`를 참고하세요.

## 라이선스

MIT. PiQuest는 MIT 라이선스의 [Pi](https://github.com/earendil-works/pi)에서 파생되었습니다.
