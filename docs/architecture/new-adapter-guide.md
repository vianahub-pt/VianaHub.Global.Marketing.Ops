# New Adapter Implementation Guide

> Guia passo a passo para implementar um novo adapter — Ciclo 5

## Visao Geral

Este guia documenta como criar um novo `PlatformAdapter` para integrar uma plataforma externa ao motor de execucao do VianaHub. Cada adapter encapsula logica especifica de uma plataforma (chamadas API, autenticacao, polling de status) atras de um contrato uniforme, permitindo que o orquestrador execute runs contra qualquer plataforma sem modificacao.

---

## Prerequisitos

- TypeScript 5.x com strict mode
- Conhecimento da interface `PlatformAdapter` e tipos auxiliares
- Acesso ao diretorio `automation/adapters/`
- Zod para validacao em runtime

---

## Passo 1: Criar o Arquivo do Adapter

Crie um novo arquivo em `automation/adapters/` seguindo a convencao de nomenclatura:

```
automation/adapters/<platform>-adapter.ts
```

Exemplos:
- `automation/adapters/google-business-adapter.ts`
- `automation/adapters/meta-ads-adapter.ts`
- `automation/adapters/tiktok-ads-adapter.ts`

---

## Passo 2: Implementar a Interface `PlatformAdapter`

O contrato exige dois metodos:

```typescript
import type {
  AdapterContext,
  AdapterResult,
  PlatformAdapter,
  StatusCheckResult,
} from "./platform-adapter.js";

export class MeuAdapter implements PlatformAdapter {
  async execute(context: AdapterContext): Promise<AdapterResult> {
    // 1. Validar o contexto
    // 2. Chamar a API da plataforma
    // 3. Retornar AdapterResult
  }

  async checkStatus(runId: string): Promise<StatusCheckResult> {
    // 1. Consultar o status remoto da plataforma
    // 2. Retornar StatusCheckResult com o estado atual
  }
}
```

### Interface `AdapterContext`

Contexto imutavel passado para `execute()`. Contem apenas campos nao-sensiveis derivados do dominio:

```typescript
interface AdapterContext {
  readonly runId: RunId;
  readonly brandId: string;
  readonly market: string;
  readonly platform: string;
  readonly operation: string;
  readonly payload: unknown;
  readonly idempotencyKey: IdempotencyKey;
}
```

**Seguranca:** O `adapterContextSchema` rejeita campos com nomes sensiveis (token, secret, password, api_key, etc.) em tempo de construcao. Nunca passe credenciais diretamente no contexto.

### Interface `AdapterResult`

Resultado retornado por `execute()`:

```typescript
interface AdapterResult {
  readonly success: boolean;
  readonly output?: unknown;
  readonly error?: RunError;
  readonly requiresManual: boolean;
}
```

**Regras de resolucao de estado:**

| `success` | `requiresManual` | `error?.retryable` | Estado resultante |
| --- | --- | --- | --- |
| `true` | `false` | — | `succeeded` |
| `false` | `true` | — | `waiting_manual` |
| `false` | `false` | `true` | `failed` (retryable) |
| `false` | `false` | `false` | `failed` (terminal) |

### Interface `StatusCheckResult`

Resultado retornado por `checkStatus()`:

```typescript
interface StatusCheckResult {
  readonly state: RunState;
  readonly output?: unknown;
  readonly error?: RunError;
}
```

---

## Passo 3: Definir Modos de Operacao

Se o adapter suporta multiplos modos (como o `FakeAdapter`), defina um tipo union:

```typescript
export type MeuAdapterMode = "create" | "update" | "delete";
```

Cada modo deve produzir um resultado previsivel e documentado. O `FakeAdapter` serve como referencia:

| Modo | `success` | `requiresManual` | `error?.retryable` | Estado |
| --- | --- | --- | --- | --- |
| `success` | `true` | `false` | — | `succeeded` |
| `failure` | `false` | `false` | `true` | `failed` (retryable) |
| `manual` | `false` | `true` | — | `waiting_manual` |
| `permanentFailure` | `false` | `false` | `false` | `failed` (terminal) |

---

## Passo 4: Integrar com o Orquestrador

O orquestrador (`orchestrator.ts`) coordena o ciclo de vida da execucao. O adapter nao precisa se preocupar com:

- Transicoes de estado (executadas por `transitionRunState`)
- Checkpointing (executado por `createCheckpoint`)
- Persistencia (executada por `RunRepository`)
- Sincronizacao de status (executada por `synchronizeStatus`)

O fluxo e:

```
executeRun(record, meuAdapter, repo)
  1. queued -> running (transicao de estado)
  2. createCheckpoint (snapshot)
  3. repo.update (persistir running)
  4. buildAdapterContext (construir contexto)
  5. meuAdapter.execute(context) ← SEU CODIGO AQUI
  6. synchronizeStatus(meuAdapter, runId, result)
  7. processResult -> estado final
  8. repo.update (persistir resultado)
```

### Exemplo: Adapter Google Business

```typescript
export class GoogleBusinessAdapter implements PlatformAdapter {
  async execute(context: AdapterContext): Promise<AdapterResult> {
    switch (context.operation) {
      case "listing-create":
        return this.createListing(context);
      case "listing-update":
        return this.updateListing(context);
      default:
        return {
          success: false,
          error: { message: `Unknown operation: ${context.operation}`, code: "UNKNOWN_OP" },
          requiresManual: false,
        };
    }
  }

  async checkStatus(runId: RunId): Promise<StatusCheckResult> {
    // Consultar API do Google Business para verificar status
    // Retornar estado consistente com o ultimo execute()
    return { state: "succeeded" };
  }
}
```

---

## Passo 5: Validacao com Zod

Valide os tipos nas fronteiras usando os schemas disponiveis:

```typescript
import { adapterResultSchema, statusCheckResultSchema } from "./platform-adapter.js";

// Validar resultado do execute
const parsed = adapterResultSchema.safeParse(result);
if (!parsed.success) {
  throw new Error("Invalid adapter result");
}

// Validar resultado do checkStatus
const statusParsed = statusCheckResultSchema.safeParse(status);
if (!statusParsed.success) {
  throw new Error("Invalid status check result");
}
```

---

## Passo 6: Testes Recomendados

### Testes Unitarios

```typescript
import { describe, expect, it } from "vitest";
import { MeuAdapter } from "./meu-adapter.js";

function createContext(overrides?: Partial<AdapterContext>): AdapterContext {
  return {
    runId: "550e8400-e29b-41d4-a716-446655440000" as RunId,
    brandId: "best-fluency",
    market: "PT",
    platform: "minha-plataforma",
    operation: "operacao-padrao",
    payload: { dados: "teste" },
    idempotencyKey: "a".repeat(64) as IdempotencyKey,
    ...overrides,
  };
}

describe("MeuAdapter", () => {
  it("execute() retorna sucesso para operacao valida", async () => {
    const adapter = new MeuAdapter();
    const context = createContext();
    const result = await adapter.execute(context);
    expect(result.success).toBe(true);
    expect(result.requiresManual).toBe(false);
  });

  it("checkStatus() retorna estado apos execute()", async () => {
    const adapter = new MeuAdapter();
    const context = createContext();
    await adapter.execute(context);
    const status = await adapter.checkStatus(context.runId);
    expect(status.state).toBe("succeeded");
  });
});
```

### Testes de Integracao

```typescript
import { executeRun, resumeRun } from "./orchestrator.js";
import { InMemoryRunRepository } from "./in-memory-repo.js";

describe("Integracao — MeuAdapter", () => {
  it("executa ciclo completo de vida via executeRun", async () => {
    const repo = new InMemoryRunRepository();
    const adapter = new MeuAdapter();
    const record = createTestRunRecord();

    await repo.create(record);
    const updated = await executeRun(record, adapter, repo);
    expect(updated.state).toBe("succeeded");
  });
});
```

### Padroes de Teste

| Cenario | O que testar |
| --- | --- |
| Sucesso | `execute()` retorna `success: true`, `checkStatus()` retorna `succeeded` |
| Falha retryable | `execute()` retorna `success: false`, `retryable: true`, `checkStatus()` retorna `failed` |
| Falha permanente | `execute()` retorna `success: false`, `retryable: false`, `checkStatus()` retorna `failed` |
| Intervencao manual | `execute()` retorna `requiresManual: true`, `checkStatus()` retorna `waiting_manual` |
| Determinismo | Mesma entrada produz mesma saida |
| Sem dados sensiveis | Nenhum token, secret ou credencial no resultado |
| Antes de execute | `checkStatus()` sem `execute()` previo retorna `queued` |

---

## Convencoes

- **Sem tipos `any`:** Todas as interfaces devem ser fortemente tipadas.
- **Imutabilidade:** Metodos de adapter recebem e retornam dados readonly.
- **Rejeicao de dados sensiveis:** Nunca passe tokens, secrets ou credenciais no `AdapterContext`.
- **Redacao de erros:** Use `redactError()` e `redactLog()` para sanitizar dados sensiveis.
- **Checkpointing:** O orquestrador cria checkpoints antes da execucao — o adapter nao precisa fazer isso.
- **Testes deterministas:** Produza resultados previsiveis para cada modo de operacao.

---

## Arquivos de Referencia

| Arquivo | Descricao |
| --- | --- |
| `automation/adapters/platform-adapter.ts` | Contrato `PlatformAdapter`, tipos `AdapterResult`, `StatusCheckResult` |
| `automation/adapters/adapter-context.ts` | `AdapterContext`, `buildAdapterContext()`, validacao Zod |
| `automation/adapters/orchestrator.ts` | `executeRun()`, `resumeRun()` |
| `automation/adapters/status-sync.ts` | `synchronizeStatus()`, reconciliacao |
| `automation/adapters/fake-adapter.ts` | `FakeAdapter` — referencia de implementacao |
| `automation/domain/run-state.ts` | `RunState`, `RunError` |
| `automation/domain/redaction.ts` | `redactError()`, `redactLog()` |
