# Sprint 2 — Adapter Framework & First Controlled Pilot

## Objetivo

Definir o contrato `PlatformAdapter`, integrá-lo com o domínio de execução (RunRecord, state machine, idempotency, checkpoints), criar um adapter fake/no-op determinístico para testes E2E, implementar o suporte a `waiting_manual` com retomada após ação humana, sincronização de status, segurança/redação e testes unitários, integração, recovery e E2E com o fake adapter. Um adapter externo real somente pode ser implementado se o repositório já possuir acesso oficial e configuração segura suficiente; caso contrário, o critério deve ser satisfeito por contrato/abstração e o acesso real permanecer explicitamente bloqueado para decisão humana.

## Critérios de Aceitação

### Contrato PlatformAdapter

- [ ] AP-01: Interface `PlatformAdapter` definida em `automation/adapters/platform-adapter.ts`
- [ ] AP-02: `PlatformAdapter` contém método `execute(context: AdapterContext): Promise<AdapterResult>`
- [ ] AP-03: `PlatformAdapter` contém método `checkStatus(runId: RunId): Promise<StatusCheckResult>`
- [ ] AP-04: `AdapterContext` inclui `runId`, `brandId`, `market`, `platform`, `operation`, `payload`, `idempotencyKey`
- [ ] AP-05: `AdapterResult` inclui `success: boolean`, `output?: unknown`, `error?: RunError`, `requiresManual: boolean`
- [ ] AP-06: `StatusCheckResult` inclui `state: RunState`, `output?: unknown`, `error?: RunError`
- [ ] AP-07: `PlatformAdapter` validado por schema Zod `platformAdapterSchema`
- [ ] AP-08: Contrato independente de infraestrutura (sem imports de drivers, HTTP clients ou frameworks)

### Integração com RunRecord e State Machine

- [ ] IN-01: `AdapterContext` é construído a partir de `RunRecord` existente
- [ ] IN-02: `AdapterResult.success === true` transita `running → succeeded`
- [ ] IN-03: `AdapterResult.success === false` transita `running → failed`
- [ ] IN-04: `AdapterResult.requiresManual === true` transita `running → waiting_manual`
- [ ] IN-05: Transições inválidas lançam erro e não alteram o estado
- [ ] IN-06: `attempt` é incrementado na transição `queued → running` antes da chamada ao adapter
- [ ] IN-07: `maxAttempts` é respeitado; excedendo o limite, `failed` é terminal
- [ ] IN-08: `idempotencyKey` é passado ao adapter no `AdapterContext`
- [ ] IN-09: `payloadFingerprint` é recalculado se o payload mudar entre tentativas

### Fake/No-Op Adapter

- [ ] FA-01: `FakeAdapter` implementa `PlatformAdapter`
- [ ] FA-02: `FakeAdapter` é determinístico: mesma entrada produce mesmo resultado
- [ ] FA-03: `FakeAdapter` suporta modo `success` (retorna `success: true`)
- [ ] FA-04: `FakeAdapter` suporta modo `failure` (retorna `success: false` com erro retryable)
- [ ] FA-05: `FakeAdapter` suporta modo `manual` (retorna `requiresManual: true`)
- [ ] FA-06: `FakeAdapter` suporta modo `permanentFailure` (retorna `success: false` com erro não retryable)
- [ ] FA-07: `FakeAdapter.checkStatus()` retorna estado consistente com o último `execute()`
- [ ] FA-08: `FakeAdapter` registrado em `automation/adapters/fake-adapter.ts`

### Execução Controlada e waiting_manual

- [ ] EC-01: Fluxo `running → waiting_manual` é suportado pelo orquestrador de execução
- [ ] EC-02: Após `waiting_manual`, adapter pode ser retomado com `resume(runId)`
- [ ] EC-03: `resume()` transita `waiting_manual → running` e chama `execute()` novamente
- [ ] EC-04: `resume()` registra evidência da ação humana no `loop-state.md`
- [ ] EC-05: Timeout em `waiting_manual` pode ser configurado (padrão: sem timeout)
- [ ] EC-06: `waiting_manual` não é atingido por esgotamento automático de tentativas

### Retomada Após Ação Humana

- [ ] RA-01: `RunRepository` suporta busca por `RunId` para retomada
- [ ] RA-02: `resume()` verifica que o estado atual é `waiting_manual` antes de prosseguir
- [ ] RA-03: `resume()` limpa o erro anterior ao transitar para `running`
- [ ] RA-04: `resume()` preserva `attempt` e `maxAttempts` do registro original
- [ ] RA-05: evidência da retomada é registrada no `RunRecord.metadata`

### Status Synchronization

- [ ] SS-01: `checkStatus()` é chamado após `execute()` para confirmar estado remoto
- [ ] SS-02: Se `checkStatus()` contradiz `AdapterResult`, o estado mais conservador prevalece
- [ ] SS-03: `checkStatus()` é chamado em retry para verificar se operação anterior completou
- [ ] SS-04: Resultado de `checkStatus()` é registrado no `RunRecord.metadata`

### Segurança e Redação

- [ ] SG-01: `AdapterContext` não contém secrets (tokens, senhas, cookies)
- [ ] SG-02: `AdapterResult.output` é redatado antes de persistir via `redactLog()`
- [ ] SG-03: `redactError()` é aplicado a erros do adapter antes de anexar ao `RunRecord`
- [ ] SG-04: Logs de execução do adapter passam por `redactLog()`
- [ ] SG-05: `FakeAdapter` não gera dados sensíveis em nenhum modo
- [ ] SG-06: Qualquer tentativa de passar secrets via `AdapterContext` deve ser rejeitada

### Checkpoints

- [ ] CK-01: Checkpoint é criado antes de cada chamada `execute()`
- [ ] CK-02: Checkpoint contém estado serializável do `RunRecord`
- [ ] CK-03: Após falha, último checkpoint válido pode ser restaurado
- [ ] CK-04: Checkpoint de `waiting_manual` inclui contexto da ação necessária

### Testes Unitários

- [ ] TU-01: Testes unitários para `PlatformAdapter` contrato (tipos e validação Zod)
- [ ] TU-02: Testes unitários para `FakeAdapter` em todos os modos
- [ ] TU-03: Testes unitários para construção de `AdapterContext` a partir de `RunRecord`
- [ ] TU-04: Testes unitários para processamento de `AdapterResult` (transições de estado)
- [ ] TU-05: Testes unitários para `checkStatus()` e `StatusCheckResult`
- [ ] TU-06: Testes unitários para redação de output e errors do adapter

### Testes de Integração

- [ ] TI-01: Teste de integração: fluxo completo `queued → running → succeeded` com `FakeAdapter`
- [ ] TI-02: Teste de integração: fluxo `queued → running → failed → queued → running → succeeded` (retry)
- [ ] TI-03: Teste de integração: fluxo `queued → running → waiting_manual → running → succeeded`
- [ ] TI-04: Teste de integração: fluxo `queued → running → failed` (erro não retryable, terminal)
- [ ] TI-05: Teste de integração: verificação de `checkStatus()` após execução

### Testes de Recovery

- [ ] TR-01: Teste de recovery: retomada de `waiting_manual` com `resume()`
- [ ] TR-02: Teste de recovery: restauração de checkpoint após falha
- [ ] TR-03: Teste de recovery: retry com `FakeAdapter` modo `failure` até `maxAttempts`
- [ ] TR-04: Teste de recovery: verificação de idempotência entre retries

### Testes E2E com Fake Adapter

- [ ] TE-01: Teste E2E: execução completa de uma operação com `FakeAdapter` modo `success`
- [ ] TE-02: Teste E2E: execução com `FakeAdapter` modo `failure` verificando retry
- [ ] TE-03: Teste E2E: execução com `FakeAdapter` modo `manual` verificando `waiting_manual`
- [ ] TE-04: Teste E2E: verificação de que `FakeAdapter` não gera secrets em logs
- [ ] TE-05: Teste E2E: verificação de que `checkStatus()` retorna estado consistente

### Documentação

- [ ] DC-01: Documentação arquitetural atualizada com seção de adapters
- [ ] DC-02: Diagrama de fluxo de execução com adapter
- [ ] DC-03: Guia de implementação de novos adapters
- [ ] DC-04: Documentação de `FakeAdapter` e modos disponíveis
- [ ] DC-05: Documentação de `waiting_manual` e fluxo de retomada

## Fora de Escopo da Sprint 2

- Implementação de adapter externo real (Google Business Profile, etc.)
- Conexão à VPS
- SQL Server ou qualquer banco de dados
- Scheduler
- Dashboard
- API HTTP
- Multi-market
- Browser automation
- Migração de dados
- Frontend

## Dependências

- Sprint 1 concluída (domínio de execução, idempotência, state machine, checkpoints)
- Zod (já implementado)
- Vitest (já implementado)
- TypeScript (já implementado)

## Status

A aplicação permanece `NO-GO` para produção.
