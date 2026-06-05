# n8n-generator

Generador de **workflows de [n8n](https://n8n.io/)** a partir de un prompt en lenguaje natural,
alineado con la metodología **[CCDD](https://github.com/MauricioPerera/ccdd)** (Context
Contract-Driven Development): el contexto que recibe el LLM se declara como un **contrato**
(`context.yaml`), se ensambla de forma verificable y se valida con guardrails *antes* de inferir.

Toma un prompt, arma el contexto bajo contrato, consulta un LLM local (Ollama), genera código del
`@n8n/workflow-sdk`, y lo valida / crea / testea contra una instancia de n8n vía un servidor MCP.

> **Estado:** prueba de concepto. El **runtime de CCDD (ensamblado + guardrails, L3) está aplicado
> de verdad**; la capa de gobernanza (firmas L1, gate de regresión L2, atestaciones) está presente
> como artefactos pero **todavía no está wireada al pipeline** (ver *Limitaciones*).

## Cómo funciona (pipeline CCDD)

`generate_with_ccdd.js` ejecuta:

1. Lista las credenciales de la instancia n8n vía MCP (`list_credentials`).
2. Escribe `inputs.json` con el `user_prompt` y las credenciales disponibles (slots runtime/dynamic).
3. **Corre `ccdd.py assemble`** — ensambla el contexto por prioridad y corre los guardrails. Si un
   guardrail bloquea (p. ej. un secreto), **el pipeline aborta** (exit 2).
4. Lee el payload ensamblado y su hash de `last-assembly.json` (auditable / reproducible).
5. Consulta el LLM local (Ollama) con ese payload.
6. Valida el código generado (`validate_workflow` vía MCP).
7. Crea el workflow en n8n (`create_workflow_from_code`).
8. Prepara pin data de prueba.
9. Corre un test run y escribe `reporte_ccdd_final.md`.

El **contrato** (`context.yaml`) declara 4 slots: `system_instructions` (crítico, firmado),
`sdk_reference` (crítico, firmado), `available_credentials` (dinámico, vía MCP) y `user_prompt`
(runtime), más guardrails `no-secrets` y `slot-references`.

## Prerrequisitos

- **[Ollama](https://ollama.com/)** corriendo en `localhost:11434` con el modelo `gemma4` (o el que
  configures). `ollama pull gemma4`.
- Una instancia de **n8n** (por defecto en `localhost:5678`).
- Un **servidor MCP** para n8n y el módulo `run_mcp_action.js` que expone `callMcp(...)`.
  ⚠️ **Hoy `run_mcp_action.js` NO está incluido en el repo** (los scripts hacen
  `require('../run_mcp_action.js')`). Ver *Limitaciones*.
- La **implementación de referencia de CCDD** ([`ccdd.py`](https://github.com/MauricioPerera/ccdd)) y
  un Python con `pyyaml`, `jsonschema`, `cryptography`.
- Node.js 18+ (usa `fetch` nativo).

## Configuración (variables de entorno)

El pipeline CCDD es configurable para que sea portable:

| Variable | Default | Qué es |
| :--- | :--- | :--- |
| `OLLAMA_URL` | `http://localhost:11434/api/chat` | Endpoint de Ollama |
| `OLLAMA_MODEL` | `qwen2.5:1.5b` | Modelo a usar |
| `CCDD_PYTHON` | `python` | Intérprete con las deps de CCDD |
| `CCDD_PATH` | `./ccdd_reference/ccdd.py` | Ruta al `ccdd.py` de la referencia |

```bash
export CCDD_PATH=/ruta/a/ccdd/ccdd_reference/ccdd.py
node generate_with_ccdd.js "Crea un flujo que se active con un webhook, filtre por 'error', y envíe por Gmail"
```

## Entrypoints

| Archivo | Qué hace | CCDD |
| :--- | :--- | :--- |
| `generate_with_ccdd.js` | **Pipeline canónico** — contrato + assemble + guardrails | ✅ sí (L3) |
| `generate_and_verify.js` | Pipeline previo, prompt directo sin contrato | ❌ no |
| `n8n_generator.py` | Generador Python con function-calling (Ollama), standalone | ❌ no |

## Limitaciones conocidas (roadmap)

Honestidad de alcance, en la misma línea que CCDD:

- **`run_mcp_action.js` no está en el repo** → el pipeline no corre como se clona. Hay que proveerlo
  (o documentar el servidor MCP). *Bloqueante de reproducibilidad.*
- **Gobernanza no enforceada:** el pipeline solo corre `assemble` (L3). No corre `ccdd.py lint`
  (verificación de firmas, L1) ni `ccdd.py diff` (gate de regresión, L2), así que `reviewers.json`,
  `attestations.json` y `expected-hashes.json` existen pero **ningún código los hace cumplir**.
- **La atestación de `system_instructions` está caduca**: cubre un hash que no es el contenido
  actual (fue un parche temporal de depuración). Debe re-atestarse o eliminarse.
- **`expr(...)` no está en el `import`** de `prompts/sdk_reference.txt` aunque los ejemplos lo usan;
  el patrón se propaga al código generado. Conviene corregirlo (y re-firmar el slot).
- Sin tests automatizados.

## Licencia

[MIT](LICENSE).
