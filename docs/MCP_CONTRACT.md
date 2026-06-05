# Contrato del servidor MCP

El pipeline (`generate_with_ccdd.js`, `generate_and_verify.js`) habla con una instancia de n8n a
través de un **servidor MCP**, vía `callMcp(method, params)` de [`run_mcp_action.js`](../run_mcp_action.js).

Ese servidor es el **n8n MCP Server oficial** (verificado contra **v1.1.0**), que n8n expone en
`/mcp-server/http`. Expone **27 herramientas**; las **5 que este pipeline usa son un subconjunto**.
`run_mcp_action.js` trae un cliente **real** (que habla el transporte de abajo) y un **mock
determinista** (`MCP_MOCK=1`) que implementa esas 5 para correr/probar sin n8n vivo.

## Transporte (verificado contra el servidor real)

- **Streamable-HTTP**: `POST` JSON-RPC 2.0 al endpoint; la respuesta llega por **SSE**
  (`Content-Type: text/event-stream`, frames `event: message` / `data: {…}`), no JSON plano.
- **Auth**: header `Authorization: Bearer <token>` (vía `N8N_MCP_TOKEN`).
- **Stateless**: no exige handshake `initialize` ni `Mcp-Session-Id`; cada POST es independiente.
- Todas las llamadas usan `method = "tools/call"`, `params = { name, arguments }`.

La respuesta de `tools/call` trae el payload **dos veces**:

```json
{ "jsonrpc": "2.0", "id": 1, "result": {
    "content": [ { "type": "text", "text": "<json-string>" } ],
    "structuredContent": { } } }
```

El consumidor hace `JSON.parse(resp.result.content[0].text)`. (`structuredContent` es el mismo objeto
ya parseado; el pipeline usa `content[0].text`.)

## Las 5 herramientas que usa el pipeline

| Herramienta | `arguments` | `text` (JSON parseado) |
| :--- | :--- | :--- |
| `list_credentials` | `{}` | `{ data: [{ id, name, type }], count }` ⚠️ |
| `validate_workflow` | `{ code }` | `{ valid: boolean, errors?: string[] }` |
| `create_workflow_from_code` | `{ code, description }` | `{ workflowId, name, url, isError? }` |
| `prepare_test_pin_data` | `{ workflowId }` | `{ nodesWithoutSchema: string[], nodeSchemasToGenerate: object }` |
| `test_workflow` | `{ workflowId, pinData }` | `{ status, executionId }` |

> ⚠️ **Diferencia mock ↔ real:** el servidor real envuelve `list_credentials` en
> `{ data: [...], count }`. El **mock** de `run_mcp_action.js` devuelve un **array pelado**
> `[{id,name,type}]` (y `generate_with_ccdd.js` asume `.length`). Contra el server real, ese acceso
> hay que adaptarlo a `.data`. Es un *follow-up* conocido; ver el README (Limitaciones).

## Las 27 herramientas del servidor (panorama)

Workflows: `search_workflows`, `get_workflow_details`, `create_workflow_from_code`, `update_workflow`,
`publish_workflow`, `unpublish_workflow`, `archive_workflow`, `validate_workflow`. ·
Ejecución: `execute_workflow`, `test_workflow`, `prepare_test_pin_data`, `get_execution`,
`search_executions`. · SDK/descubrimiento: `get_sdk_reference`, `search_nodes`, `get_node_types`,
`get_suggested_nodes`. · Credenciales: `list_credentials`. · Data tables: `search_data_tables`,
`create_data_table`, `rename_data_table`, `add_data_table_column`, `delete_data_table_column`,
`rename_data_table_column`, `add_data_table_rows`. · Org: `search_projects`, `search_folders`.

## No confundir con la n8n Public REST API

La [Public REST API](https://docs.n8n.io/api/) (`/api/v1`, OpenAPI) es una **superficie distinta y
más limitada**: tiene `GET /credentials` y `POST /workflows` (que toma **JSON**, no código SDK), pero
**no** valida código, **no** ejecuta workflows on-demand, **no** tiene pin-data. Las capacidades
SDK-aware y de ejecución del pipeline (`validate_workflow`, `create_workflow_from_code`,
`test_workflow`, …) **solo existen en el MCP server**, no en la API pública.

## Apuntar al servidor real

```bash
export N8N_MCP_URL=http://localhost:5678/mcp-server/http
export N8N_MCP_TOKEN=<tu JWT de n8n>     # NO lo commitees
node generate_with_ccdd.js "tu prompt"
```

Sin `N8N_MCP_URL` (o con `MCP_MOCK=1`), `run_mcp_action.js` usa el **mock** — útil para el smoke test
y para validar el cableado del pipeline sin infraestructura.
