# Reporte de Verificación CCDD + n8n

Este reporte documenta el ciclo de vida del flujo bajo la metodología CCDD.

## Detalles del Contrato de Contexto (CCDD)
* **Nombre de Contrato:** n8n-workflow-generator
* **Tokens Usados:** 809 / 6692 tokens
* **Hash del Payload:** 5215e29c224d9afc910886c20b6a3a74c70eaf20513b1993bdf4092ab8d384d5

## Detalles del Flujo Creado
* **Nombre:** Webhook Filter Gmail Workflow
* **ID:** KG9qwgOM2LMTFUKj
* **URL:** [Lienzo de n8n](http://localhost:5678/workflow/KG9qwgOM2LMTFUKj)

## Código SDK Validado
```javascript
import { workflow, node, trigger, newCredential } from '@n8n/workflow-sdk';

// Define the webhook trigger with a basic configuration.
const webhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Webhook Trigger',
    parameters: { path: '/webhook', httpMethod: 'POST', responseMode: 'onReceived' },
    position: [250, 300]
  },
  output: [{ body: 'hello error' }]
});

// Define a filter node that checks if the message contains 'error'.
const checkError = ifElse({
  version: 2.2,
  config: {
    name: 'Check Error',
    parameters: {
      conditions: {
        options: { caseSensitive: false, typeValidation: 'loose' },
        conditions: [
          {
            leftValue: expr('{{ $json.body?.message ?? $json.message }}'),
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

// Define a Gmail node that sends an email containing the error message.
const sendEmail = node({
  type: 'n8n-nodes-base.gmail',
  version: 2.1,
  config: {
    name: 'Send Email via Gmail',
    parameters: {
      resource: 'message',
      operation: 'send',
      sendTo: 'user@example.com',
      subject: 'Error Alert',
      messageType: 'text/plain',
      message: expr('Error: {{ $json.body?.message ?? $json.message }}')
    },
    credentials: { gmailOAuth2: newCredential('Gmail OAuth2') }
  },
  output: [{ id: '123' }]
});

// Chain the workflow with conditional branches.
export default workflow('webhook-filter-gmail', 'Webhook Filter Gmail Workflow')
  .add(webhook)
  .to(checkError
    .onTrue(sendEmail)
  );
```

## Simulación de Ejecución (Test Run)
* **ID de Ejecución:** 54
* **Resultado:** **SUCCESS**
* **Mocks de Pin Data Inyectados:**
```json
{
  "Webhook Trigger": [
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
