# AgentLink 등록부 참조

## 정본 위치
리포·패키지 소유권과 의존 관계의 정본은 `agentlink-platform-core`의 `registry/`와 `docs/architecture/`이다.
- 등록부 링크: https://github.com/capitalparser/agentlink-platform-core/tree/main/registry
- R0 등록부는 PR https://github.com/capitalparser/agentlink-platform-core/pull/5 로 2026-10-15 main에 병합됐다(병합 커밋 0eb37a5).
- 이 문서는 상태값(SHA·검증 상태)을 복제하지 않는다.

## 리포 식별
| 항목 | 내용 |
| --- | --- |
| 정식 이름 | `agentlink-platform-mcp` |
| 이전 이름(alias) | `agentlink-mcp-server` |
| GitHub ID | 1169308319 |
| 등록부 repository id | `repo.mcp` |
| component ids | `mcp.server`, `mcp.funding-adapter` |

## 소유 영역
### 소유하는 것
- 도구 정의, 입력 검증, Core HTTP adapter, MCP 응답 변환, launcher의 MCP 부분, 최소 연결·진단 상태

### 소유하지 않는 것
- 보조금 판단 규칙, 원문 DB, API 제공자 키 저장, 결제 원장

## 경계 주의
- 기존 9개 도구는 StubDataProvider 기반이며 실연동이 아니다. 이는 2026-10-15 이전 main 시점 관찰이며, 이후 다른 세션의 병합으로 달라졌을 수 있다(Core 등록부 finding F-012).
- funding 도구는 PR #2 미병합 상태이다.
- `package.json`의 `repository.url`은 정식 owner·이름과 다르며 Core 등록부 finding `F-001`로만 기록하고 이 변경에서 수정하지 않는다.
