# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/). Este proyecto aplica la
metodología [CCDD](https://github.com/MauricioPerera/ccdd): los cambios al contrato (prompts firmados)
pasan por el gate determinista (firma + atestación + CI).

## [0.1.0] — 2026-06-05

Primera versión empaquetada. El pipeline quedó **verificado end-to-end contra un n8n MCP Server real**
(v1.1.0) + Ollama: descubre nodos y credenciales, genera código SDK válido y gobernado, linkea
credenciales reales por ID, crea el workflow y lo ejecuta con efecto externo real. Detalle del camino
en [`docs/FINDINGS.md`](docs/FINDINGS.md).

### Gobernanza (CCDD)
- Gate de gobernanza en CI (`ccdd-gate.yml`): **L1 lint + L2 diff** como *required check* sobre `main`
  protegida (`enforce_admins`). Pin a la referencia de CCDD por **SHA inmutable** (== release v0.3.1).
- L3 runtime: `ccdd assemble` + guardrails antes de cada inferencia.
- Atestaciones Ed25519 vigentes para los slots críticos firmados.

### Pipeline
- **`run_mcp_action.js`**: cliente del n8n MCP Server (streamable-HTTP, SSE, Bearer) + mock determinista.
- **Grounding de nodos** (`search_nodes`): el modelo usa node types reales, no inventados.
- **Grounding de credenciales** (`list_credentials`) + linkeo por **ID exacto** (`newCredential(name,id)`).
- **`sdk_reference.txt`** reescrito a la sintaxis real del SDK (sin `import`, validado contra el server).
- Loop de auto-corrección (hasta 3 intentos con el feedback de `validate_workflow`).
- Portabilidad: `OLLAMA_URL`/`OLLAMA_MODEL`/`CCDD_PYTHON`/`CCDD_PATH`/`N8N_MCP_URL`/`N8N_MCP_TOKEN` por entorno.

### Pruebas y CI
- `test_pipeline_smoke.js` + `pipeline-smoke.yml`: pipeline e2e con n8n+LLM mock y **ensamble CCDD real**.
- Verificación por SHA de cada corrida; nada a `main` sin CI verde.

### Documentación
- `README.md`, [`docs/MCP_CONTRACT.md`](docs/MCP_CONTRACT.md) (interfaz del MCP server, 27 tools),
  [`docs/FINDINGS.md`](docs/FINDINGS.md) (los 7 hallazgos del e2e real), `LICENSE` (MIT), `reporte_ejemplo.md`.

### Alcance honesto
- El e2e completo requiere infraestructura externa (n8n + MCP + Ollama). El smoke mockea lo externo
  con frontera explícita. Modelos chicos (1.5B) no alcanzan para generación fiable; `gemma4` sí.
- OAuth2 real (p. ej. Gmail) requiere consentimiento humano en el navegador — fuera de alcance del PoC.
