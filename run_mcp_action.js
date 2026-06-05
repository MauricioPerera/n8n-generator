'use strict';

/*
 * run_mcp_action.js — puente entre los scripts generadores y el MCP server de n8n.
 *
 * Antes este módulo vivía FUERA del repo (los scripts hacían require('../run_mcp_action.js')),
 * así que el pipeline no corría desde un clon limpio. Ahora vive acá y expone `callMcp`.
 *
 * Herramientas que el pipeline consume (vía method 'tools/call'):
 *   - list_credentials        -> [{ id, name, type }]
 *   - validate_workflow       -> { valid: bool, errors?: [...] }
 *   - create_workflow_from_code -> { workflowId, name, url, isError? }
 *   - prepare_test_pin_data   -> { nodesWithoutSchema: [...], nodeSchemasToGenerate: {...} }
 *   - test_workflow           -> { status, executionId }
 *
 * Dos modos:
 *   - REAL : si N8N_MCP_URL está seteado, hace POST JSON-RPC a esa URL (un MCP server de
 *            n8n con transporte HTTP). Requiere n8n vivo — NO verificable en CI.
 *   - MOCK : si N8N_MCP_URL no está, o MCP_MOCK=1, devuelve respuestas canónicas y
 *            deterministas. Permite correr y PROBAR el pipeline (incluido el ensamble CCDD
 *            real) desde un clon limpio, sin n8n ni Ollama. La frontera del mock es explícita.
 *
 * La forma de retorno imita la respuesta JSON-RPC de un MCP server:
 *   { jsonrpc:'2.0', id, result: { content: [{ type:'text', text: <json-string> }] } }
 * que es exactamente lo que los scripts parsean: JSON.parse(resp.result.content[0].text).
 */

let _id = 0;

function mockToolResult(params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  switch (name) {
    case 'list_credentials':
      return [{ id: 'cred-mock-1', name: 'Gmail OAuth2 (mock)', type: 'gmailOAuth2' }];

    case 'validate_workflow': {
      // Validación superficial pero NO trivial: exige export default workflow(...) y el import del SDK.
      // Suficiente para que el smoke test distinga un payload sano de uno roto.
      const code = String(args.code || '');
      const ok = /export\s+default\s+workflow\s*\(/.test(code) && /@n8n\/workflow-sdk/.test(code);
      return ok
        ? { valid: true }
        : { valid: false, errors: ['(mock) falta `export default workflow(...)` o el import de @n8n/workflow-sdk'] };
    }

    case 'create_workflow_from_code':
      return { workflowId: 'wf-mock-001', name: 'Flujo mock', url: 'https://n8n.local/workflow/wf-mock-001' };

    case 'prepare_test_pin_data':
      return { nodesWithoutSchema: ['Webhook Trigger'], nodeSchemasToGenerate: {} };

    case 'test_workflow':
      return { status: 'success', executionId: 'exec-mock-001' };

    default:
      throw new Error(`run_mcp_action (mock): herramienta desconocida '${name}'`);
  }
}

function wrapJsonRpc(id, payloadObj) {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: JSON.stringify(payloadObj) }] },
  };
}

/**
 * Invoca una acción del MCP server de n8n (o su mock).
 * @param {string} method  típicamente 'tools/call'
 * @param {object} params  { name, arguments } para 'tools/call'
 * @returns {Promise<object>} respuesta JSON-RPC con result.content[0].text (string JSON)
 */
async function callMcp(method, params) {
  const id = ++_id;
  const url = process.env.N8N_MCP_URL;
  const useMock = process.env.MCP_MOCK === '1' || !url;

  if (useMock) {
    if (method !== 'tools/call') return wrapJsonRpc(id, {}); // initialize/otros: no-op en mock
    return wrapJsonRpc(id, mockToolResult(params));
  }

  // Modo REAL: JSON-RPC 2.0 sobre HTTP contra el MCP server de n8n.
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status} ${res.statusText} (N8N_MCP_URL=${url})`);
  const json = await res.json();
  if (json.error) throw new Error(`MCP error: ${JSON.stringify(json.error)}`);
  return json;
}

module.exports = { callMcp };
