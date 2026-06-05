# Contrato del servidor MCP

El pipeline (`generate_with_ccdd.js`, `generate_and_verify.js`) habla con una instancia de n8n a
través de un **servidor MCP**, vía `callMcp(method, params)` de [`run_mcp_action.js`](../run_mcp_action.js).

Este documento define **la interfaz que ese servidor debe cumplir**. El repo no incluye un servidor
MCP funcional: trae `run_mcp_action.js` con un cliente real (JSON-RPC sobre `N8N_MCP_URL`) y un **mock
determinista** (`MCP_MOCK=1`) que implementa exactamente este contrato para correr/probar sin n8n vivo
(ver [`run_mcp_action.js`](../run_mcp_action.js) como fuente de verdad).

## Transporte

`callMcp` envía JSON-RPC 2.0 y espera una respuesta con esta forma:

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [ { "type": "text", "text": "<json-string>" } ] } }
```

El consumidor hace `JSON.parse(resp.result.content[0].text)`. Es decir: **el payload útil de cada
herramienta es un string JSON dentro de `result.content[0].text`.**

Todas las llamadas usan `method = "tools/call"` y `params = { name, arguments }`.

## Herramientas

| Herramienta | `arguments` | `text` (JSON parseado) |
| :--- | :--- | :--- |
| `list_credentials` | `{}` | `[{ id, name, type }]` — credenciales disponibles en la instancia |
| `validate_workflow` | `{ code }` | `{ valid: boolean, errors?: string[] }` |
| `create_workflow_from_code` | `{ code, description }` | `{ workflowId, name, url, isError? }` |
| `prepare_test_pin_data` | `{ workflowId }` | `{ nodesWithoutSchema: string[], nodeSchemasToGenerate: object }` |
| `test_workflow` | `{ workflowId, pinData }` | `{ status, executionId }` |

### Ejemplos de respuesta (el `text` ya parseado)

```jsonc
// list_credentials
[ { "id": "cred-1", "name": "Gmail OAuth2", "type": "gmailOAuth2" } ]

// validate_workflow  (code válido)
{ "valid": true }
// validate_workflow  (code inválido)
{ "valid": false, "errors": ["falta export default workflow(...)"] }

// create_workflow_from_code
{ "workflowId": "wf-123", "name": "Webhook Filter Gmail", "url": "http://localhost:5678/workflow/wf-123" }

// prepare_test_pin_data
{ "nodesWithoutSchema": ["Webhook Trigger"], "nodeSchemasToGenerate": {} }

// test_workflow
{ "status": "success", "executionId": "exec-123" }
```

## Implementar uno

Cualquier servidor MCP que exponga estas 5 herramientas con estas formas sirve. Para apuntar el
pipeline a uno real:

```bash
export N8N_MCP_URL=http://localhost:<puerto>/mcp   # tu servidor MCP de n8n
node generate_with_ccdd.js "tu prompt"
```

Sin `N8N_MCP_URL` (o con `MCP_MOCK=1`), `run_mcp_action.js` usa el mock — útil para el smoke test y
para validar el cableado del pipeline sin infraestructura.
