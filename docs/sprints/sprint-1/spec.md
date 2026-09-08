# Sprint 1: Execution Domain & Idempotency

## Objetivo

Criar o domínio de execuções antes de acessar plataformas externas, garantindo idempotência, recuperação segura e histórico operacional sem armazenar secrets.

## Critérios de Aceitação

### RunId

- [ ] Tipo `RunId` definido como string UUID v4
- [ ] Função `createRunId()` gera IDs determinísticos a partir de payload
- [ ] IDs são únicos por combinação de (brand, market, platform, operation)
- [ ] IDs são imutáveis após criação

### RunRecord

- [ ] Interface `RunRecord` com campos: `id`, `brand`, `market`, `platform`, `operation`, `status`, `attempt`, `maxAttempts`, `createdAt`, `updatedAt`, `completedAt`, `error`, `checkpoint`
- [ ] Validação Zod para `RunRecord`
- [ ] Campos `error` e `checkpoint` são opcionais
- [ ] `attempt` inicia em 1

### Estados de Execução

- [ ] Estados definidos: `queued`, `running`, `waiting_manual`, `succeeded`, `failed`, `cancelled`
- [ ] Estado inicial: `queued`
- [ ] Transições válidas documentadas

### Máquina de Estados

- [ ] Transições validadas por função `transitionRunStatus()`
- [ ] Transições inválidas lançam erro
- [ ] `waiting_manual` só é atingido a partir de `running`
- [ ] `succeeded` e `failed` são estados terminais
- [ ] `cancelled` só é atingido a partir de `queued` ou `running`

### Idempotência Determinística

- [ ] Chave de idempotência derivada de (brand, market, platform, operation, payload_hash)
- [ ] `payload_hash` é SHA-256 do payload serializado
- [ ] Payload não inclui dados sensíveis (tokens, senhas, cookies)
- [ ] Função `computeIdempotencyKey()` é pura e determinística

### Payload Fingerprint

- [ ] Função `fingerprintPayload()` serializa payload de forma canônica
- [ ] Remove campos sensíveis antes de hash
- [ ] Retorna SHA-256 como hex string

### Tentativa e Retry

- [ ] `maxAttempts` configurável (padrão: 3)
- [ ] `attempt` incrementado a cada retry
- [ ] Backoff exponencial com jitter
- [ ] `waiting_manual` atingido quando `attempt >= maxAttempts`

### Redação de Erros e Logs

- [ ] Função `redactError()` remove tokens, senhas, cookies
- [ ] Função `redactLog()` sanitiza logs antes de persistir
- [ ] Padrões de redação: tokens JWT, API keys, passwords, session IDs

### RunStore Interface

- [ ] Interface `RunStore` definida
- [ ] Métodos: `create()`, `get()`, `update()`, `list()`, `findByKey()`
- [ ] Independente de tecnologia de persistência

### Implementação Local

- [ ] `FileRunStore` implementa `RunStore`
- [ ] Persistência atômica (temp + rename)
- [ ] Separação de lógica de domínio e persistência
- [ ] Diretório de runs configurável

### Checkpoints

- [ ] Checkpoints persistidos atomicamente
- [ ] Checkpoint contém estado serializável
- [ ] Resume a partir de checkpoint salvo

### Locking

- [ ] Lock por RunId para prevenir concorrência
- [ ] Lock com timeout configurável
- [ ] Release automático em estados terminais

### Dry-Run

- [ ] Modo `dry-run` executa sem efeitos colaterais
- [ ] Validações rodam mesmo em dry-run
- [ ] Logs indicam modo dry-run

### Testes

- [ ] Testes unitários para cada componente
- [ ] Testes de integração para fluxo completo
- [ ] Testes de recuperação após falha
- [ ] Cobertura mínima: 80% statements

### Documentação

- [ ] Documentação arquitetural atualizada
- [ ] Diagrama de estados
- [ ] Guia de uso do RunStore

## Fora de Escopo

- Implementação SQL Server
- Conexão à VPS
- Migrations
- Frontend
- API HTTP
- Adapters
- Browser automation
- Scheduler
- Outros mercados

## Dependências

- Zod (já implementado)
- Vitest (já implementado)
- TypeScript (já implementado)

## Status

A aplicação permanece `NO-GO` para produção.
