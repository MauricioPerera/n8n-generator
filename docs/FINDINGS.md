# Hallazgos — lo que reveló correr el sistema contra un n8n real

Este documento registra lo que **emergió de ejecutar** el pipeline contra un n8n MCP Server real
(v1.1.0) + Ollama, no lo que se planeó. Es la contraparte aplicada de la tesis de
[CCDD](https://github.com/MauricioPerera/ccdd): *lo que no se corre desde un entorno real no está
verificado.* Cada hallazgo de abajo **solo apareció al ejecutar de verdad** — ninguno era visible con
el mock, y varios contradecían lo que el código asumía.

El pipeline pasó de "corre solo con mock" a un sistema que, contra el n8n real, **descubre nodos y
credenciales, genera código SDK válido y gobernado, linkea credenciales reales por ID, crea el
workflow y lo ejecuta con efecto externo real**. Llegar ahí destapó siete capas, en orden.

---

## 1. El transporte: el cliente rompía sobre SSE

El `run_mcp_action.js` original hacía `res.json()` sobre la respuesta del MCP server. Pero el n8n MCP
Server habla **streamable-HTTP**: responde por **SSE** (`text/event-stream`, frames `data: {…}`) con
**Bearer auth**, no JSON plano. El cliente habría fallado en la primera llamada real.

**Fix:** parser de SSE + `Authorization: Bearer` (vía `N8N_MCP_TOKEN`). Stateless, sin handshake.
Verificado end-to-end contra el server.

## 2. La forma de `list_credentials`: `{data,count}`, no un array

El server real envuelve la lista en `{ data: [...], count }`. El pipeline asumía un array pelado y
hacía `.length` → contra el server real **no leía ninguna credencial**. El mock devolvía la forma
equivocada, así que el smoke test pasaba con falsa confianza.

**Fix:** normalizar a `.data`; **alinear el mock a la forma real** para que el smoke valide lo que la
realidad usa.

## 3. El cheat-sheet inducía código inválido: `import` prohibido

El cheat-sheet (`prompts/sdk_reference.txt`) empezaba con `import { … } from '@n8n/workflow-sdk'`. El
SDK real **rechaza las sentencias `import`** ("Import declarations are not allowed in SDK code") y los
nombres reservados (`const workflow = workflow(...)`). El modelo copiaba el import → validación
fallaba los 3 intentos, sin crear nunca un workflow.

> Ironía instructiva: veníamos de "arreglar el import de `expr`" en el cheat-sheet — un fix correcto
> *para el cheat-sheet que teníamos*, pero el cheat-sheet **entero** estaba desalineado con el SDK que
> el server valida. Solo corriendo de verdad se vio.

**Fix:** reescribir el cheat-sheet a la sintaxis autoritativa (de `get_sdk_reference`), **validado**
contra `validate_workflow` (valid: true). Cambio gobernado (slot crítico firmado → re-firma + atestación).

## 4. La capacidad del modelo importa: 1.5B no alcanza

Con el cheat-sheet corregido, `qwen2.5:1.5b` (el modelo configurado) seguía fallando: copiaba la línea
de composición pero **no definía las consts** (`Unknown identifier: 'webhook' is not defined`). Es una
limitación de capacidad, no de prompt.

**Fix:** un modelo capaz (`gemma4`) genera el patrón define-y-encadena correctamente y **valida al
primer intento**. El cheat-sheet era necesario pero no suficiente; el tamaño del modelo es una variable real.

## 5. Alucinación de node types → grounding con `search_nodes`

`gemma4` validaba y **creaba** el workflow, pero inventaba un node type inexistente
(`n8n-nodes-base.log`). `validate_workflow` valida **sintaxis SDK, no existencia de nodos**, así que
pasaba — y reventaba en ejecución ("Unrecognized node type").

**Fix:** un paso de descubrimiento. Antes de generar, el pipeline llama `search_nodes`, parsea los
`n8n-nodes-base.*` **reales** y los inyecta como *grounding* (slot dinámico `available_nodes`, "usá
SOLO estos"). Resultado verificado: ejecución SUCCESS, sin nodos alucinados.

## 6. Linkeo de credencial: `newCredential('Name')` deja el nodo SIN auth

El modelo referenciaba la credencial por nombre, `newCredential('Nombre')`. Verificado con
`GET /workflows/{id}`: eso produce `node.credentials: []` — **el nodo queda sin credencial**. La firma
de dos argumentos, `newCredential('Nombre', 'id')`, **sí** linkea a la credencial real.

**Fix:** el cheat-sheet enseña a referenciar por **ID exacto** (tomado de las credenciales
disponibles). Verificado e2e: `gemma4` generó `newCredential('CCDD Demo Header Auth', '<id real>')` y
el workflow quedó linkeado. Cambio gobernado.

## 7. Los tres modos de ejecución de n8n

Para una llamada externa **real** hubo que entender el modelo de ejecución de n8n:

- **`test_workflow`** (lo que usa el pipeline) → **pinea** los nodos externos. No hay llamada real; es para testear borradores.
- **`execute_workflow` modo `production`** → exige el workflow **publicado/activo**, y un **manual trigger no se puede activar** ("no trigger node").
- **`execute_workflow` modo `manual`** → ejecuta el borrador **de verdad**, sin pin. Por acá la llamada externa **fírió**.

**Verificación final:** el workflow generado, ejecutado en modo manual, llamó a `httpbin.org/get` de
verdad — httpbin devolvió la IP pública real del origen. Efecto externo confirmado, sin mock ni pin.

---

## Verificaciones laterales

- **Crear credenciales NO está bloqueado por el plan** (n8n self-hosted/community): `POST /credentials`
  → 200, CRUD completo verificado por la **Public REST API** (`X-N8N-API-KEY`). El "límite del plan
  gratis" no aplicaba — los 400 iniciales eran de validación de schema, no de permiso.
- **Dos superficies distintas:** el **MCP Server** (Bearer, SDK-aware, ejecución) lista credenciales
  pero no las gestiona; la **Public REST API** (API key) hace el CRUD. No son intercambiables.

## El hilo conductor

Siete capas, cero detectables sin ejecutar contra el servidor real. El mock daba verde en cada una.
La disciplina que las encontró es la misma de CCDD: **verificar contra la realidad, no inferir** —
y cada cambio que tocó el contrato (prompts firmados) pasó por el gate determinista (firma +
atestación + CI verde por sha), incluso mientras el sistema se descubría a sí mismo corriendo.
