'use strict';

/*
 * Smoke test del pipeline — corre desde un clon limpio, sin n8n ni Ollama.
 *
 * Parte 1: contrato del mock de run_mcp_action.js (las 5 herramientas devuelven la forma
 *          que los scripts parsean).
 * Parte 2: ejecuta generate_with_ccdd.js de punta a punta con MCP y LLM mockeados, pero
 *          con el ENSAMBLE CCDD REAL en el medio (ccdd.py assemble + guardrails). Verifica
 *          que el pipeline carga, ensambla bajo contrato, valida y "ejecuta".
 *
 * Lo único mockeado es lo externo no-determinista (n8n + LLM). El núcleo CCDD es real.
 *
 * Requiere, para la Parte 2, una implementación de CCDD accesible vía:
 *   CCDD_PATH    (ruta a ccdd.py)        — default: ./ccdd_reference/ccdd.py
 *   CCDD_PYTHON  (intérprete de python)  — default: python
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  - ${name}`); }
  catch (e) { failures++; console.error(`  FAIL- ${name}\n        ${e.message}`); }
}

// ---------------------------------------------------------------------------
// Parte 1 — contrato del mock MCP
// ---------------------------------------------------------------------------
console.log('Parte 1: contrato de run_mcp_action.js (mock)');
process.env.MCP_MOCK = '1';
const { callMcp } = require('./run_mcp_action.js');

async function tool(name, args) {
  const r = await callMcp('tools/call', { name, arguments: args || {} });
  return JSON.parse(r.result.content[0].text);
}

(async () => {
  check('list_credentials -> { data: [{id,name,type}], count }', () => {
    return tool('list_credentials').then((c) => {
      assert(c && Array.isArray(c.data) && c.data.length > 0, 'esperaba { data: [...] } no vacío');
      assert(typeof c.count === 'number', 'falta count');
      assert(c.data[0].id && c.data[0].name && c.data[0].type, 'faltan campos id/name/type');
    });
  });

  // assert async: re-ejecuto secuencial para mensajes claros
  const creds = await tool('list_credentials');
  assert(creds.data[0].type === 'gmailOAuth2');

  const goodCode = "import { workflow } from '@n8n/workflow-sdk';\nexport default workflow('x','X');";
  const badCode = 'const x = 1;';
  check('validate_workflow acepta código sano', async () =>
    assert.strictEqual((await tool('validate_workflow', { code: goodCode })).valid, true));
  check('validate_workflow rechaza código sin export/import', async () =>
    assert.strictEqual((await tool('validate_workflow', { code: badCode })).valid, false));
  check('create_workflow_from_code -> {workflowId,name,url}', async () => {
    const o = await tool('create_workflow_from_code', { code: goodCode, description: 'd' });
    assert(o.workflowId && o.url, 'faltan workflowId/url');
  });
  check('prepare_test_pin_data -> {nodesWithoutSchema:[]}', async () => {
    const o = await tool('prepare_test_pin_data', { workflowId: 'wf' });
    assert(Array.isArray(o.nodesWithoutSchema), 'nodesWithoutSchema no es array');
  });
  check('test_workflow -> {status,executionId}', async () => {
    const o = await tool('test_workflow', { workflowId: 'wf', pinData: {} });
    assert(o.status === 'success' && o.executionId, 'status/executionId inválidos');
  });

  // dar tiempo a que las aserciones async impriman antes de la Parte 2
  await new Promise((r) => setTimeout(r, 50));

  // -------------------------------------------------------------------------
  // Parte 2 — pipeline end-to-end (ensamble CCDD real, externo mockeado)
  // -------------------------------------------------------------------------
  console.log('\nParte 2: generate_with_ccdd.js end-to-end (CCDD real, n8n+LLM mock)');
  const ccddPath = process.env.CCDD_PATH || path.join(__dirname, 'ccdd_reference', 'ccdd.py');
  const haveCcdd = fs.existsSync(ccddPath);
  if (!haveCcdd) {
    console.error(`  SKIP- no encuentro ccdd.py en ${ccddPath} (set CCDD_PATH). La Parte 2 requiere CCDD.`);
    failures++; // en CI siempre está; localmente, ausencia = fallo de setup, no "ok"
  } else {
    check('pipeline corre y completa con exit 0', () => {
      const out = execFileSync('node', [path.join(__dirname, 'generate_with_ccdd.js'), 'flujo de prueba smoke'], {
        cwd: __dirname,
        encoding: 'utf-8',
        env: { ...process.env, MCP_MOCK: '1', CCDD_LLM_MOCK: '1', CCDD_PATH: ccddPath },
      });
      assert(/Ensamble exitoso/.test(out), 'no se ejecutó el ensamble CCDD real');
      assert(/Validaci.n exitosa/.test(out), 'no pasó la validación del flujo');
      assert(/RESULTADO FINAL PIPELINE CCDD/.test(out), 'el pipeline no llegó al final');
    });
  }

  console.log(failures === 0 ? '\nSMOKE: OK' : `\nSMOKE: ${failures} fallo(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();
