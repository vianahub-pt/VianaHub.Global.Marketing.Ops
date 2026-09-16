# FakeAdapter Reference

> Documentacao do `FakeAdapter` e seus modos — Ciclo 5

## Visao Geral

O `FakeAdapter` e um adapter deterministico usado para testar o pipeline de execucao sem dependencias externas. Ele implementa a interface `PlatformAdapter` e produz resultados previsiveis para cada modo de operacao.

**Localizacao:** `automation/adapters/fake-adapter.ts`

---

## Proposito

- Testar o ciclo de vida completo de execucao (`executeRun`, `resumeRun`)
- Validar transicoes de estado sem chamadas a APIs externas
- Verificar comportamento de retry, falha permanente e intervencao manual
- Garantir que nenhum dado sensiveis e gerado em nenhum modo

---

## Modos Disponiveis

O `FakeAdapter` aceita um modo no construtor:

```typescript
type FakeAdapterMode = "success" | "failure" | "manual" | "permanentFailure";
```

### Modo `success`

```typescript
const adapter = new FakeAdapter("success");
```

| Campo | Valor |
| --- | --- |
| `success` | `true` |
| `requiresManual` | `false` |
| `error` | `undefined` |
| `checkStatus()` | `succeeded` |

**Uso:** Testar caminho feliz — execucao completa sem erros.

### Modo `failure`

```typescript
const adapter = new FakeAdapter("failure");
```

| Campo | Valor |
| --- | --- |
| `success` | `false` |
| `requiresManual` | `false` |
| `error.message` | `"Simulated transient failure"` |
| `error.code` | `"FAKE_TRANSIENT"` |
| `error.retryable` | `true` |
| `checkStatus()` | `failed` |

**Uso:** Testar mecanismo de retry — o erro e retryable e o sistema deve tentar novamente ate atingir `maxAttempts`.

### Modo `manual`

```typescript
const adapter = new FakeAdapter("manual");
```

| Campo | Valor |
| --- | --- |
| `success` | `false` |
| `requiresManual` | `true` |
| `error` | `undefined` |
| `checkStatus()` | `waiting_manual` |

**Uso:** Testar fluxo de intervencao manual — a run entra em `waiting_manual` e so continua com `resumeRun()`.

### Modo `permanentFailure`

```typescript
const adapter = new FakeAdapter("permanentFailure");
```

| Campo | Valor |
| --- | --- |
| `success` | `false` |
| `requiresManual` | `false` |
| `error.message` | `"Simulated permanent failure"` |
| `error.code` | `"FAKE_PERMANENT"` |
| `error.retryable` | `false` |
| `checkStatus()` | `failed` |

**Uso:** Testar falha terminal — o erro nao e retryable e a run nao deve ser reexecutada.

---

## Comportamento de `checkStatus()`

O `checkStatus()` do `FakeAdapter` retorna um estado consistente com o ultimo `execute()`:

| Condicao | `checkStatus()` retorna |
| --- | --- |
| Nenhum `execute()` chamado | `{ state: "queued" }` |
| Apos `execute()` com modo `success` | `{ state: "succeeded" }` |
| Apos `execute()` com modo `failure` | `{ state: "failed", error: { retryable: true } }` |
| Apos `execute()` com modo `manual` | `{ state: "waiting_manual" }` |
| Apos `execute()` com modo `permanentFailure` | `{ state: "failed", error: { retryable: false } }` |

**Nota:** O `FakeAdapter` ignora o `runId` passado para `checkStatus()` e sempre retorna baseado no ultimo resultado de `execute()`. Isso e intencional para manter determinismo nos testes.

---

## Como Usar em Testes

### Exemplo Basico

```typescript
import { describe, expect, it } from "vitest";
import { FakeAdapter } from "./fake-adapter.js";
import type { AdapterContext } from "./platform-adapter.js";
import type { RunId } from "../domain/idempotency.js";
import type { IdempotencyKey } from "../domain/idempotency.js";

function createContext(): AdapterContext {
  return {
    runId: "550e8400-e29b-41d4-a716-446655440000" as RunId,
    brandId: "best-fluency",
    market: "PT",
    platform: "fake-platform",
    operation: "test-operation",
    payload: { name: "Test" },
    idempotencyKey: "a".repeat(64) as IdempotencyKey,
  };
}

describe("Exemplo — FakeAdapter", () => {
  it("modo success produz resultado previsivel", async () => {
    const adapter = new FakeAdapter("success");
    const context = createContext();

    const result = await adapter.execute(context);
    expect(result.success).toBe(true);

    const status = await adapter.checkStatus(context.runId);
    expect(status.state).toBe("succeeded");
  });
});
```

### Exemplo com Orquestrador

```typescript
import { executeRun, resumeRun } from "./orchestrator.js";
import { InMemoryRunRepository } from "./in-memory-repo.js";

describe("Ciclo de vida — com FakeAdapter", () => {
  it("execucao bem-sucedida via executeRun", async () => {
    const repo = new InMemoryRunRepository();
    const adapter = new FakeAdapter("success");
    const record = createTestRecord(); // helper para criar RunRecord

    await repo.create(record);
    const updated = await executeRun(record, adapter, repo);

    expect(updated.state).toBe("succeeded");
    expect(updated.finishedAt).toBeDefined();
  });

  it("retry apos falha retryable", async () => {
    const repo = new InMemoryRunRepository();
    const adapter = new FakeAdapter("failure");
    const record = createTestRecord({ maxAttempts: 3 });

    await repo.create(record);
    const updated = await executeRun(record, adapter, repo);

    expect(updated.state).toBe("failed");
    expect(updated.error?.retryable).toBe(true);
  });

  it("intervencao manual via resumeRun", async () => {
    const repo = new InMemoryRunRepository();
    const adapter = new FakeAdapter("manual");
    const record = createTestRecord();

    await repo.create(record);
    const afterExecute = await executeRun(record, adapter, repo);

    expect(afterExecute.state).toBe("waiting_manual");

    // Simular intervencao humana e retomar
    const successAdapter = new FakeAdapter("success");
    const afterResume = await resumeRun(afterExecute.runId, successAdapter, repo);

    expect(afterResume.state).toBe("succeeded");
  });
});
```

---

## Garantias de Determinismo

O `FakeAdapter` garante que:

1. **Mesma entrada produz mesma saida** — executar `execute()` duas vezes com o mesmo contexto retorna resultados identicos.
2. **Nenhum dado sensiveis** — nenhum modo gera tokens, secrets, passwords, API keys ou credenciais.
3. **Estado consistente** — `checkStatus()` sempre reflete o ultimo `execute()`.
4. **Construtor padrao** — `new FakeAdapter()` equivale a `new FakeAdapter("success")`.

---

## Arquivo de Testes

Os testes do `FakeAdapter` estao em `automation/adapters/fake-adapter.test.ts` e cobrem:

- Cada modo individualmente (`success`, `failure`, `manual`, `permanentFailure`)
- `checkStatus()` antes e apos `execute()`
- Determinismo (mesma entrada = mesma saida)
- Ausencia de dados sensiveis em todos os modos
- Construtor padrao (modo `success`)

---

## Arquivos de Referencia

| Arquivo | Descricao |
| --- | --- |
| `automation/adapters/fake-adapter.ts` | Implementacao do `FakeAdapter` |
| `automation/adapters/fake-adapter.test.ts` | Testes unitarios |
| `automation/adapters/platform-adapter.ts` | Contrato `PlatformAdapter` |
| `automation/adapters/orchestrator.ts` | Orquestrador que utiliza adapters |
