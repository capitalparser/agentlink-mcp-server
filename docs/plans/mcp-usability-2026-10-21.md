# MCP 연결 계획 — 계획만, 미구현

기준은 공개 `capitalparser/agentlink-platform-mcp`의 main `37e0f87e8a8cd699b541b8018060928a0a44e4e5`다. 이 문서는 후속 전송 작업의 계획이며 이번 PR에서 코드 변경, 런타임 검증, 실제 Claude 사용은 하지 않았다.

## 현재 상태와 담당 경로

- `docs/SUBSIDY_DOMAIN_BRIDGE.md`는 stdio 자식 브리지와 읽기 전용 도구 7개의 입력·오류·환경 경계를 기록한다. 과거의 도구 부재 주장을 되풀이하지 않는다.
- 담당 경로: `src/domains/tax/bridge.ts`, `src/domains/tax/tools.ts`, `src/domains/subsidy/bridge.ts`, `src/domains/subsidy/tools.ts`, `src/server.ts`, `src/index.ts`, `docs/SUBSIDY_DOMAIN_BRIDGE.md`.
- 이 리포의 책임은 전송, 설치 구성, handshake, capability 진단, 안전한 오류 변환이다. 도메인 판단·원문 의미는 소비자 계약 소유자가 정한다.

## 우선순위와 선행 조건

1. **P0 첫 구성은 tax-only:** `src/domains/tax/bridge.ts`와 `src/domains/tax/tools.ts`의 실제 도구 목록·schema를 확인해 `tax_plan_work` 왕복을 먼저 성립시킨다. 선택 subsidy child 부재는 이 구성의 시작·호출을 막지 않는다.
2. **P0 같은 기준을 subsidy에 적용:** 선택 child가 설정된 경우에만 `src/domains/subsidy/bridge.ts`와 `src/domains/subsidy/tools.ts`의 전체 목록·schema를 대조한다. 이때만 `subsidy_list_workflows` 호출을 수행한다.
3. 두 경로 모두 기존 브리지를 재사용하고 initialize 뒤 paginated `tools/list` 전체를 확인한다. 검증된 도구만 광고하고 자식 재시작 때 목록 검증을 다시 한다. 일반 stub은 기본 목록에서 숨기고 명시적 demo 설정에서만 드러낸다.
4. **실제 Claude gate:** 새 세션에서 tax 도구 확인 → `tax_plan_work` 호출·응답 확인을 먼저 한다. subsidy는 선택 자식이 설정된 경우에만 목록 확인과 `subsidy_list_workflows` 호출을 추가한다. 업무별 source-bearing 승인과 적용 판단은 이 전송 계획의 범위가 아니다.

## 미래 완료 시험 — 아직 실행하지 않음

- 정상: 깨끗한 프로세스에서 initialize와 전체 목록을 읽고, 광고된 이름·schema가 자식 목록과 일치하며, 응답의 `structuredContent`·text·경고가 원형 그대로 왕복한다.
- 정상: 선택 자식 미설정이어도 필수 연결은 작동하고 진단에 미설정 상태가 보인다. 명시적 demo가 아니면 synthetic stub은 목록에 없다.
- 거절: 필수 도구 누락, schema 불일치, 잘못된 응답, 실행 파일·import 오류, timeout이면 typed 오류와 안전한 진단을 내고 내부 경로·stderr를 노출하지 않는다.
- 거절: 선택 자식 장애가 별도 필수 연결을 막지 않는다. 실패한 자식은 다음 호출에서 재연결할 수 있고 이전 client 실패가 새 연결을 닫지 않는다.
- 정상: tax-only 프로세스는 subsidy child가 없어도 `tax_plan_work`를 노출·호출하고, 선택 subsidy가 설정된 경우에만 검증된 `subsidy_list_workflows`를 추가한다.
- 실제 Claude gate: 새 세션에서 `tax_plan_work`를 먼저 확인·호출한다. subsidy child가 설정됐으면 그때만 `subsidy_list_workflows`도 호출한다. 입력·출력·도구/schema digest·오류 경고를 익명화한 receipt로 남긴다. 이 gate는 미실행이다.
- 계획된 좁은 검증: `npm run build` 후 `node --test tests/tax/bridge.test.mjs tests/subsidy/bridge.test.mjs`. 실제 변경 경로에 맞춰 필요한 파일만 실행하며, 이번에는 실행하지 않았다.

## 다음 작업, 복귀, 제외

- 첫 다음 작업은 tax-only로 시작해 현재 main의 `src/domains/tax/bridge.ts`·`src/domains/tax/tools.ts`에 P0 handshake/list/schema 대조와 `tax_plan_work` 왕복을 먼저 구체화하는 것이다. 이어 같은 확인을 optional subsidy child에 적용한다.
- 실패 시 새 노출을 끄고 직전 검증 구성으로 되돌린다. credential이나 내부 오류 문자열은 진단에 싣지 않는다.
- 제외: 새 도메인 판정기, 통합 router, 일반 HTTP adapter, 설치 자동 다운로드, stub의 기본 노출, 사용자별 원문·사례 추가.
- 이번 문서 PR은 계획만 추가한다. 빌드·테스트·Claude 왕복은 실행하지 않았고 어떤 gate도 통과했다고 주장하지 않는다.
