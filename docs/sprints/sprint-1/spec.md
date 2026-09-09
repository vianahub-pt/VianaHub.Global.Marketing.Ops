# Sprint 1: Execution Domain & Idempotency

## Objetivo

Criar o domínio de execuções antes de acessar plataformas externas, garantindo idempotência, recuperação segura e histórico operacional sem armazenar secrets.

## Critérios de Aceitação

### Identidade e Idempotência

- [ ] Tipo `RunId` definido como string UUID v4 aleatório
- [ ] Função `createRunId()` gera IDs aleatórios, não determinísticos
- [ ] `RunId` é único para cada execução, mesmo para a mesma combinação de brand/market/platform/operation
- [ ] Tipo `IdempotencyKey` definido como string
- [ ] Função `computeIdempotencyKey()` é pura e determinística
- [ ] `IdempotencyKey` é derivado da identidade lógica da operação e do payload canónico
- [ ] Tipo `PayloadFingerprint` definido como string hex SHA-256
- [ ] Função `fingerprintPayload()` serializa payload de forma canónica e retorna hash
- [ ] Payload não inclui dados sensíveis (tokens, senhas, cookies) antes do hash
- [ ] Várias execuções são permitidas para a mesma combinação brand/market/platform/operation
- [ ] Somente repetição idempotente da mesma solicitação deve reutilizar a mesma `IdempotencyKey`

### RunRecord

- [ ] Interface `RunRecord` com campos:
  - `schemaVersion: number`
  - `runId: RunId`
  - `brandId: string`
  - `market: string`
  - `platform: string`
  - `operation: string`
  - `state: RunState`
  - `attempt: number`
  - `maxAttempts: number`
  - `idempotencyKey: IdempotencyKey`
  - `payloadFingerprint: PayloadFingerprint`
  - `createdAt: Date`
  - `updatedAt: Date`
  - `startedAt?: Date`
  - `finishedAt?: Date`
  - `error?: RunError`
  - `metadata?: Record<string, unknown>`
- [ ] Validação Zod para `RunRecord`
- [ ] Não misturar `id` com `runId`, `brand` com `brandId`, ou `status` com `state`

### Estados de Execução

- [ ] Estados definidos: `queued`, `running`, `waiting_manual`, `succeeded`, `failed`, `cancelled`
- [ ] Estado inicial: `queued`

### Máquina de Estados

- [ ] Transições validadas por função `transitionRunState()`
- [ ] Transições inválidas lançam erro
- [ ] Matriz de transições:

| Origem           | Destinos permitidos                                                    |
| ---------------- | ---------------------------------------------------------------------- |
| `queued`         | `running`, `cancelled`                                                 |
| `running`        | `waiting_manual`, `succeeded`, `failed`, `cancelled`                   |
| `waiting_manual` | `running`, `failed`, `cancelled`                                       |
| `failed`         | `queued`, exclusivamente quando retryable e com tentativas disponíveis |
| `succeeded`      | nenhum                                                                 |
| `cancelled`      | nenhum                                                                 |

- [ ] `succeeded` e `cancelled` são estados terminais
- [ ] `failed` é terminal quando não houver retry permitido
- [ ] `waiting_manual` representa necessidade real de intervenção humana
- [ ] `waiting_manual` não é atingido por esgotamento automático de tentativas

### Tentativas

- [ ] Uma execução em `queued` começa com `attempt = 0`
- [ ] A transição `queued -> running` incrementa `attempt`
- [ ] `attempt` nunca pode ultrapassar `maxAttempts`
- [ ] `maxAttempts` configurável (padrão: 3)
- [ ] Retry somente pode ocorrer quando o erro for classificado como retryable
- [ ] Retry somente pode ocorrer quando ainda houver tentativas disponíveis

### Redação de Erros e Logs

- [ ] Função `redactError()` remove tokens, senhas, cookies
- [ ] Função `redactLog()` sanitiza logs antes de persistir
- [ ] Padrões de redação: tokens JWT, API keys, passwords, session IDs

### RunRepository (Contrato de Domínio)

- [ ] Interface `RunRepository` definida
- [ ] Métodos: `create()`, `getById()`, `update()`, `list()`, `findByIdempotencyKey()`
- [ ] Independente de tecnologia de persistência
- [ ] Concorrência otimista documentada como contrato, sem implementação de infraestrutura

### Checkpoints (Contrato)

- [ ] Modelo/contrato de checkpoint definido, se necessário
- [ ] Checkpoint contém estado serializável

### Testes

- [ ] Testes unitários para cada componente de domínio
- [ ] Testes de integração para fluxo completo
- [ ] Testes de recuperação após falha
- [ ] Cobertura mínima: 80% statements

### Documentação

- [ ] Documentação arquitetural atualizada
- [ ] Diagrama de estados
- [ ] Guia de uso do RunRepository

## Fora de Escopo da Sprint 1

- Implementação SQL Server
- Conexão à VPS
- Migrations
- Frontend
- API HTTP
- Adapters
- Browser automation
- Scheduler
- Outros mercados
- `FileRunStore`
- Persistência JSON/CSV de runs
- Gravação atômica em arquivos
- Locking concreto
- Implementação concreta de checkpoints
- Backoff exponencial com jitter
- Implementação concreta de `dry-run`, `resume` ou `check`

CSV permanece apenas como importação, exportação, seed e compatibilidade; não será a base transacional de produção.

A implementação do repositório SQL Server e a API pertencem à Sprint 2.

## Dependências

- Zod (já implementado)
- Vitest (já implementado)
- TypeScript (já implementado)

## Status

A aplicação permanece `NO-GO` para produção.
