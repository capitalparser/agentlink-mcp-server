# 보조금·R&D 도메인 브리지 (M1-a)

우산 MCP 서버에서 `regulation_reference.server`의 읽기 전용 도구 7개를 로컬 stdio 자식으로 연결합니다. 첫 도구 호출 때만 자식을 시작하며, 동시 첫 호출은 한 자식을 공유합니다. 서버 종료 시 자식을 닫습니다. 세무 도메인과 별도 모듈·프로세스로 동작합니다.

| 우산 도구 | 도메인 도구 | 입력 |
|---|---|---|
| `subsidy_list_workflows` | `list_workflows` | 없음 |
| `subsidy_get_reference_bundle` | `get_reference_bundle` | `query` 1–2000자, 필수 `context` 객체, `limit` 1–20 (기본 8), 선택 nullable `matter` 객체 |
| `subsidy_search_references` | `search_references` | `query` 1–2000자, 선택 nullable `context`, `limit` 1–20 (기본 8) |
| `subsidy_get_reference` | `get_reference` | `reference_id` 문자열 |
| `subsidy_answer_practitioner_question` | `answer_practitioner_question` | `question` 1–500자와 아래 선택 필드 |
| `subsidy_list_practitioner_topics` | `list_practitioner_topics` | 선택 nullable `regime`, 엄격한 boolean `include_uncarded` (기본 false) |
| `subsidy_get_official_text` | `get_official_text` | `doc_ref_id` (최대 80자, `[a-z]+\.[a-z0-9-]+`), `article_key` (십진 숫자 7자리) 또는 공백만으로 구성되지 않은 `search` (최대 60자) 정확히 하나 |

모든 도구 annotation은 `readOnlyHint:true`, `destructiveHint:false`, `idempotentHint:true`, `openWorldHint:false`입니다. 결과는 검토용 초안이며 적용 여부는 판단되지 않습니다. 공식 원문은 국가법령정보센터 로컬 사본이며 수집 이후 개정 여부는 결과의 `public_url`에서 확인해야 합니다. 브리지에서 외부 원문을 가져오지 않습니다.

## 입력 계약

문자 수는 Python과 같은 Unicode 코드 포인트 수입니다. 이모지 한 글자도 한 글자로 셉니다. 정규식은 전체 문자열에 일치해야 하며 마지막 줄바꿈을 허용하지 않습니다.

`context`는 다음 필드만 허용합니다. `task`: `labor|travel|purchasing|plan_change|settlement`; `role`: `applicant|official|reviewer|compliance|fund_manager|accountant|taxpayer|tax_practitioner`; `ministry` 최대 100자; `project` 최대 200자; `as_of` 실제 ISO 날짜 `YYYY-MM-DD`; `funding_scheme`: `national|local`; `domain` 최대 80자; `workflow` 최대 100자. 이 필드는 모두 생략하거나 null을 전달할 수 있습니다. `facts`는 생략 가능한 임의 문자열→문자열 맵이며 null은 허용하지 않습니다. Context의 facts에는 실무 질문 facts의 개수·키·길이 제한을 적용하지 않습니다. `matter`는 도메인 경계의 임의 객체로 전달하며 세무용 필드를 요구하지 않습니다.

실무 질문의 선택 필드는 모두 생략 또는 null이 가능합니다.

| 필드 | 규칙 |
|---|---|
| `perspective` | `recipient|verifier` |
| `regime` | `subsidy|local_gov_subsidy|national_rnd|sme_support_general` |
| `stage` | 최대 80자 (빈 문자열 허용) |
| `as_of` | 실제 ISO 날짜 `YYYY-MM-DD`, 연도 0001–9999 |
| `facts` | 최대 20개, 키 `[a-z][a-z0-9_]*`, 문자열 값 최대 100자 |
| `need_id` | 최대 120자, `pn\.[a-z_]+\.[a-z_]+\.\d{2}` (Python과 같은 Unicode 십진 숫자) |
| `conversation_state` | 임의 객체; 상태 내용의 의미 검증은 도메인 담당 |
| `followed_action_id` | `na\.[0-9]{2}` (ASCII 숫자) |

도메인의 `next_actions`와 `conversation_state`를 보존합니다. 실무자 후속 작업의 정확한 호출 변환은 아래 “입력 경계와 후속 작업”의 English/Korean instructions를 따릅니다. 브리지 응답 자체의 도구 이름이나 상태를 고쳐 쓰지 않습니다. Work 계열 `plan_work`, `get_document`, `audit_coverage`, `list_forms`, `get_form` 및 sourceful 활성화는 범위 밖이며 등록하지 않습니다.

범위·타입 오류와 알 수 없는 최상위/Context 필드는 자식을 호출하기 전에 거부합니다. Python이 과거에 형 변환하던 Context JSON 문자열, 문자열/boolean limit, Context의 epoch/자정 datetime 날짜는 받지 않습니다. 객체·정수·ISO 날짜라는 이 브리지의 계약을 따르며 형 변환 호환성을 제공하지 않습니다. Python `strip`과 같은 공백 판정을 사용하므로 U+0085/U+001C–001F 검색은 거부하고 U+FEFF 자체는 유효한 검색 문자열로 취급합니다.

## 설치와 설정

접근 가능한 Python 환경에 도메인 패키지를 제공하세요. 예: 도메인 소스에서 `pip install /path/to/services/regulation-reference` 또는 아래 `AGENTLINK_SUBSIDY_MCP_PYTHONPATH`로 해당 `src` 디렉터리를 지정합니다. 필요한 도메인 의존성과 레지스트리·catalog도 로컬에 있어야 합니다. 브리지가 자동으로 설치하거나 데이터를 내려받지 않습니다.

| 환경 변수 | 설명 | 기본값 |
|---|---|---|
| `AGENTLINK_SUBSIDY_MCP_COMMAND` | Python 실행 파일 또는 stdio 명령 | `python3` |
| `AGENTLINK_SUBSIDY_MCP_ARGS` | 인자 JSON 문자열 배열; 잘못된 형식은 기본값 사용 | `["-m","regulation_reference.server"]` |
| `AGENTLINK_SUBSIDY_MCP_PYTHONPATH` | 자식 PYTHONPATH override | 부모의 허용된 PYTHONPATH |
| `REGULATION_CATALOG` | 도메인 catalog JSON 경로 | 도메인의 상대 경로 `data/catalog.json` |
| `REGULATION_PRACTITIONER_REGISTRY_DIR` | 카드·질문·계기 레지스트리 폴더 | 도메인 패키지 기준 registry |
| `REGULATION_OFFICIAL_TEXT_DIR` | 공식 원문 로컬 저장소 | 도메인 기본값 |
| `REGULATION_USAGE_DIR` | 로컬 수요 집계 저장 폴더 | 도메인 기본값 |
| `REGULATION_USAGE_SIGNALS` | `off`로 로컬 사용 신호 기록 중지 | 도메인 기본 `on` |

예:

```sh
AGENTLINK_SUBSIDY_MCP_COMMAND=/path/to/venv/bin/python \
AGENTLINK_SUBSIDY_MCP_ARGS='["-B","-m","regulation_reference.server"]' \
AGENTLINK_SUBSIDY_MCP_PYTHONPATH=/path/to/services/regulation-reference/src \
REGULATION_CATALOG=/path/to/catalog.json \
REGULATION_PRACTITIONER_REGISTRY_DIR=/path/to/services/regulation-reference/registry \
REGULATION_USAGE_SIGNALS=off node dist/index.js
```

자식에게 전달하는 환경 변수는 **`PATH, HOME, LANG, LC_ALL, TZ, TMPDIR, PYTHONPATH, REGULATION_CATALOG, REGULATION_PRACTITIONER_REGISTRY_DIR, REGULATION_OFFICIAL_TEXT_DIR, REGULATION_USAGE_DIR, REGULATION_USAGE_SIGNALS`**뿐입니다. SDK 기본 상속 변수도 허용 목록 밖이면 제거합니다. `AGENTLINK_CREDENTIALS_PATH`, `LAW_API_ID`, `AGENTLINK_CORE_*`, `REGULATION_HOST/PORT/EXPOSURE/ALLOWED_HOSTS`, 프록시 및 인증서 변수와 다른 변수는 전달하지 않습니다. macOS Node 런타임은 빈 환경으로 시작해도 `__CF_USER_TEXT_ENCODING`을 자체 생성할 수 있으며 부모 값 전달과는 별개입니다.

## 응답·오류·프라이버시

성공 시 객체 `structuredContent`와 이를 JSON으로 표현한 text를 그대로 반환합니다. FastMCP의 주제 목록 결과는 `{ "result": [...] }`로 감싸져 있으며 감싸기를 해제하지 않습니다. `{ "result": { "error": ... } }`도 그대로 유지합니다. 정상 응답의 `{ "error": "invalid_input", ... }`, `official_text_unavailable` 같은 구조적 오류도 변형하지 않으며 `isError`를 붙이지 않습니다.

프로세스·프로토콜 실패는 `subsidy-bridge-error.v1`의 `SUBSIDY_DOMAIN_UNAVAILABLE|SUBSIDY_DOMAIN_TIMEOUT|SUBSIDY_DOMAIN_TOOL_ERROR|SUBSIDY_DOMAIN_ERROR`와 고정 안전 메시지로 반환하며 `isError:true`입니다. 자식 `isError`는 안전한 TOOL_ERROR로 바꾸고, 객체가 아닌 structuredContent는 ERROR로 처리합니다. 경로·stderr·예외 원문은 노출하지 않습니다. 호출 제한시간은 30초입니다. 호출 타임아웃만 발생하면 공유 자식을 유지하고, 크래시 이후 다음 호출은 다시 연결합니다. 호출 실패는 그 호출이 사용한 client가 여전히 현재 client일 때만 해당 client를 reset합니다. 오래된 client의 지연 실패가 새 client를 닫거나 지우지 않으며, 연결 실패는 자신이 만든 후보 client만 닫습니다. 명시적 서버 종료는 현재 client를 닫습니다.

브리지는 질문 원문·facts 값을 로그에 남기거나 입력을 저장하지 않습니다. 사용 신호는 도메인 자식이 로컬에 기록하는 수요 집계이며, 호스트 운영자만 환경 변수로 기록 위치와 on/off를 정합니다. 사용자가 도구 입력으로 바꿀 수 없습니다. 이 연결은 로컬 전용입니다. 원격 배포 시 사용자에게 로컬 사용 신호의 기록과 처리 방식을 고지해야 합니다.

## 입력 경계와 후속 작업

모든 도구는 문자열과 객체 키의 UTF-16 surrogate 쌍을 검사합니다. 유효한 surrogate pair, 한글, 결합 문자, 아랍어 십진 숫자, NUL은 그대로 유지하며 정규화하지 않습니다. 파싱된 인수 객체(기본값 포함)를 기준으로 최상위 객체 깊이는 0이고, 객체/배열 자식마다 깊이가 1 증가합니다. 컨테이너 깊이 20과 `JSON.stringify` 후 UTF-8 65,536바이트는 경계값으로 허용하고 그보다 큰 값은 도메인 호출 전에 고정된 invalid-arguments 오류로 거부합니다. 배열도 컨테이너로 셉니다. 문자열/키 검사는 payload 전체를 순회하며 깊이 검사는 직렬화 전에 수행합니다.

**English:** For a selected `answer_practitioner_question` follow-up, prefix the supported domain `tool.name` with `subsidy_`; replace `$conversation_state` with the exact `conversation_state` from the previous response and `$answer` with the user's answer; preserve the remaining arguments and state; and include the required `followed_action_id: action.action_id` (for example, `na.01`). `get_official_text` has no `followed_action_id` field, so do not add one. This transformation is performed by the caller; the bridge preserves the domain response.

**한국어:** 선택한 `answer_practitioner_question` 후속 작업은 지원되는 도메인 `tool.name` 앞에 `subsidy_`를 붙이고, `$conversation_state`를 직전 응답의 정확한 `conversation_state`로, `$answer`를 사용자의 답변으로 바꿉니다. 나머지 인수와 상태를 보존하고 필수 `followed_action_id: action.action_id`(예: `na.01`)를 포함합니다. `get_official_text`에는 `followed_action_id` 필드가 없으므로 추가하지 않습니다. 이 변환은 호출 측에서 하며 브리지는 도메인 응답을 보존합니다.

## 검증과 한계

정적 JSON Schema의 휴대성은 이 런타임 검증과 완전히 같지 않습니다. 특히 문자열 코드 포인트 길이, 실제 날짜, 상호 배타 조건 및 전체 payload 깊이/바이트 제한은 런타임에서 적용됩니다. 다른 MCP 호출자도 도구 호출 시 이 런타임 검증을 거칩니다. portable schema 동등성은 P3-4로 연기했습니다.

Funding MCP PR #2 병합 후 통합 체크리스트: 실제 registry와 도구를 다시 읽고 `tests/subsidy/bridge.test.mjs`의 T1에서 정확한 전체 도구 목록, BASELINE 상수 및 숫자 라벨을 funding 도구를 포함해 갱신합니다. 모든 기존 tax/subsidy 단언을 유지하고 전체 시험을 다시 실행합니다. 목록을 부분집합 비교로 약화하거나 아직 확인되지 않은 도구 이름을 추측하지 않습니다.

```sh
npm test
# 실제 도메인 E2E는 선택 실행
AGENTLINK_SUBSIDY_E2E_PYTHON=/path/to/venv/bin/python \
AGENTLINK_SUBSIDY_E2E_PYTHONPATH=/path/to/services/regulation-reference/src npm test
```

Python/source 경로가 없으면 T6는 이유와 함께 skip됩니다. T6는 실제 Python 모듈과 실제 카드·질문 레지스트리를 사용하고 공식 원문 폴더를 빈 시험 폴더로 격리합니다. 생성된 source catalog가 없으면 임시 빈 catalog로 서버 시작 조건만 충족합니다. 실제 규정 검색 catalog의 완전성이나 공식 원문 보유를 검증했다는 뜻은 아닙니다. 실제 배포에는 유효한 catalog 경로가 필요하며, 원문이 없으면 도메인의 구조적 미보유 오류가 전달됩니다.
