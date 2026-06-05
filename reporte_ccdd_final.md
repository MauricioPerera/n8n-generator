# Reporte de Verificación CCDD + n8n

Este reporte documenta el ciclo de vida del flujo bajo la metodología CCDD.

## Detalles del Contrato de Contexto (CCDD)
* **Nombre de Contrato:** n8n-workflow-generator
* **Tokens Usados:** 729 / 6692 tokens
* **Hash del Payload:** f221bfea7cc36626f54288a209c3418b141d51b245a692ff46ddf8edecbb85cc

## Detalles del Flujo Creado
* **Nombre:** Webhook Filter Error Alert Workflow
* **ID:** iR6l5c6rT277vcNt
* **URL:** [Lienzo de n8n](http://localhost:5678/workflow/iR6l5c6rT277vcNt)

## Código SDK Validado
```javascript
import { workflow, node, trigger, newCredential, ifElse } from '@n8n/workflow-sdk';

// 1. Webhook Trigger (Start)
const webhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Webhook Listener',
    parameters: { path: 'webhooks/error-check', httpMethod: 'POST', responseMode: 'onReceived' },
    position: [250, 300]
  },
  output: [{ json: { body: "System error detected during processing." } }] // Dummy data containing 'error'
});

// 2. Conditional Filter (Check for 'error')
const checkError = ifElse({
  version: 2.2,
  config: {
    name: 'Is Error Detected',
    parameters: {
      conditions: {
        options: { caseSensitive: false, typeValidation: 'loose' },
        conditions: [
          {
            leftValue: expr('{{ $json.body }}'), // Check the body content
            operator: { type: 'string', operation: 'contains' },
            rightValue: 'error'
          }
        ],
        combinator: 'and'
      }
    },
    position: [500, 300]
  }
});

// 3. Gmail Node (Action)
const sendErrorEmail = node({
  type: 'n8n-nodes-base.gmail',
  version: 2.1,
  config: {
    name: 'Send Error Alert via Email',
    parameters: {
      resource: 'message',
      operation: 'send',
      sendTo: 'alert@example.com', // Target recipient for the alert
      subject: '🚨 CRITICAL SYSTEM ERROR ALERT 🚨',
      messageType: 'text',
      // Use the body content from the webhook as the message detail
      message: expr('An error was detected in the system workflow. Details: {{ $json.body }}')
    },
    credentials: { gmailOAuth2: newCredential('Gmail Auth Credential') }, // Placeholder credential
    position: [750, 300]
  },
  output: [{ id: 'email-sent' }]
});

export default workflow('webhook-filter-gmail', 'Webhook Filter Error Alert Workflow')
  .add(webhook)
  .to(checkError
    .onTrue(sendErrorEmail)
  );
```

## Simulación de Ejecución (Test Run)
* **ID de Ejecución:** 52
* **Resultado:** **SUCCESS**
* **Mocks de Pin Data Inyectados:**
```json
{
  "Webhook Listener": [
    {
      "json": {
        "body": {
          "message": "Hola, este es un webhook de prueba autogenerado bajo CCDD."
        },
        "headers": {
          "user-agent": "n8n-mcp-ccdd-verifier"
        },
        "query": {
          "test": "true"
        }
      }
    }
  ]
}
```
