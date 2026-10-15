# AgentLink Korea MCP Server

**AI agents' gateway to Korean public & financial data**
**AI 에이전트를 위한 한국 공공·재무 데이터 게이트웨이**

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that provides AI agents with structured access to Korean government and financial data sources — including HomeTax (홈택스), KONEPS (나라장터), Supreme Court (대법원), and more.

## Available Tools

### Tax Data (세무 데이터)
| Tool | Description |
|------|-------------|
| `get_vat_data` | Retrieve VAT data for a business (부가가치세 데이터 조회) |
| `get_tax_invoice` | Look up electronic tax invoices (전자세금계산서 조회) |
| `get_income_tax_summary` | Retrieve income tax summary (소득세 요약 조회) |

### Business Registration (사업자 정보)
| Tool | Description |
|------|-------------|
| `verify_business_registration` | Verify a business registration number (사업자등록번호 진위 확인) |
| `get_business_info` | Retrieve detailed business info (사업자 상세 정보 조회) |

### Public Data (공공 데이터)
| Tool | Description |
|------|-------------|
| `search_public_notices` | Search government notices (공공 고시/공고 검색) |
| `get_procurement_data` | Retrieve procurement/bidding data from KONEPS (조달청 입찰/계약 데이터 조회) |

### Legal Data (법률 데이터)
| Tool | Description |
|------|-------------|
| `search_court_precedents` | Search court precedents (대법원 판례 검색) |

### Disaster & Safety (재난 안전)
| Tool | Description |
|------|-------------|
| `get_disaster_alerts` | Retrieve disaster alerts from MOIS (행정안전부 재난 알림 조회) |

## Quick Start

### Installation

```bash
npm install
npm run build
```

### Usage with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentlink-korea": {
      "command": "node",
      "args": ["/path/to/agentlink-mcp-server/dist/index.js"]
    }
  }
}
```

### Usage with Claude Code

```bash
claude mcp add agentlink-korea node /path/to/agentlink-mcp-server/dist/index.js
```

### Direct Execution

```bash
npx agentlink-mcp-server
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev
```

## 세무 도메인 연결

`agentlink-domain-tax-mcp`(Python stdio MCP 서버)를 로컬 stdio 브리지로 연결합니다. 자식 프로세스는 첫 호출 시 지연 실행되며 서버 종료 시 함께 종료됩니다. 기존 스텁 세무 도구(`get_vat_data` 등)는 그대로 유지됩니다.

| 환경 변수 | 설명 | 기본값 |
|---|---|---|
| `AGENTLINK_TAX_MCP_COMMAND` | 실행 명령 | `python3` |
| `AGENTLINK_TAX_MCP_ARGS` | 인자 (JSON 배열) | `["-m","agentlink_tax.server"]` |
| `AGENTLINK_TAX_MCP_PYTHONPATH` | 자식 프로세스 `PYTHONPATH` (선택) | - |

자식 프로세스에는 `PATH, HOME, LANG, LC_ALL, TZ, TMPDIR, PYTHONPATH, AGENTLINK_CREDENTIALS_PATH, AGENTLINK_TAX_REGISTRY, AGENTLINK_AUTOMATION_OFFER_PATH, HTTPS_PROXY, HTTP_PROXY, NO_PROXY`(소문자 변형 포함), `SSL_CERT_FILE, REQUESTS_CA_BUNDLE`만 전달됩니다.

도메인 레지스트리를 찾을 수 있어야 합니다: 도메인 패키지를 editable 설치하거나, `AGENTLINK_TAX_REGISTRY`를 지정하거나, `AGENTLINK_TAX_MCP_PYTHONPATH`(또는 `PYTHONPATH`)를 소스 트리로 지정하세요.

도구 (모두 읽기 전용): `tax_list_workflows`, `tax_get_workflow_contract`, `tax_plan_work`, `tax_get_automation_offer`, `tax_list_rule_cards`, `tax_search_law`, `tax_check_business_status`, `tax_list_practice_cards`, `tax_list_holidays`, `tax_get_schedule`, `tax_find_office`, `tax_search_interpretations`, `tax_get_tribunal_decision`, `tax_search_forms`, `tax_list_form_guides`, `tax_get_form_field_tips`. `tax_plan_work`는 선택 인자 `include_evidence`(서식 원본·근거 후보 첨부)와 `include_filling_guide`(작성 안내 초안 첨부)를 받습니다. 성공 결과는 도메인 서버의 `structuredContent`를 그대로 반환하며(오류 결과의 원문은 전달하지 않고 고정된 안전한 메시지의 `TAX_DOMAIN_TOOL_ERROR`로 대체), 초안일 뿐 적용 여부는 판단되지 않고 세액은 계산하지 않습니다. 호출 제한시간은 30초이며, 실패 시 `tax-bridge-error.v1` (`TAX_DOMAIN_UNAVAILABLE` / `TAX_DOMAIN_TIMEOUT` / `TAX_DOMAIN_TOOL_ERROR` / `TAX_DOMAIN_ERROR`)을 반환합니다.

`automation_offer`는 법률 내용이 아닌 별도 섹션이며, 연락 채널은 `not_configured`일 수 있습니다.

상태: 로컬 stdio 브리지 (원격/호스팅 미지원).

## Architecture

```
agentlink-mcp-server (Public - this repo)
├── MCP tool definitions & schemas
├── Transport layer (stdio / HTTP)
└── DataProvider interface
        │
        ▼
agentlink-core-engine (Private)
├── Data crawling & aggregation
├── Data normalization pipeline
└── Source-specific adapters
        │
        ▼
agentlink-billing-x402 (Private)
├── x402 micropayment processing
├── Usage metering
└── Wallet management
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[Apache-2.0](LICENSE)
