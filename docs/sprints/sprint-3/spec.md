# Sprint 3 — Production Persistence + First Real Controlled Adapter

## Objetivo

Implementar persistência durável para `RunRepository` e checkpoints via filesystem local, habilitar recovery após restart, adicionar dry-run verificável para o primeiro adapter externo controlado (Google Business Profile — Best Fluency / PT), e validar todo o fluxo com testes unitários, integração, recovery e E2E local.

## Decisão Arquitetural — Persistência

Para esta Sprint, utilizar **filesystem local durável** (não banco de dados).

Motivos:

- `RunRepository` já é technology-agnostic (definido em `automation/domain/repository.ts`)
- `InMemoryRunRepository` é somente para testes (definido em `automation/adapters/in-memory-repo.ts`)
- Banco de dados permanece fora do MVP (roadmap.md: Sprint 5+)
- Não adicionar infraestrutura desnecessária antes do primeiro production pilot

## Critérios de Aceitação

### FileRunRepository

- [ ] FR-01: `FileRunRepository` implementa `RunRepository` e está registrada em `automation/adapters/file-run-repo.ts`
- [ ] FR-02: Diretório de armazenamento é configurável via parâmetro ou variável de ambiente, com valor padrão seguro fora do diretório fonte
- [ ] FR-03: Cada `RunRecord` é persistido como arquivo JSON individual, nomeado por `runId`; paths validados contra path traversal usando `realpathSync` ou equivalente
- [ ] FR-04: Escrita é atômica (arquivo temporário + rename); temporário é removido em caso de falha durante escrita
- [ ] FR-05: `create()` falha se já existir arquivo com o mesmo `runId`; `update()` falha se o arquivo não existir
- [ ] FR-06: `update()` utiliza optimistic concurrency via campo `revision` no envelope de persistência (não `schemaVersion`, que é somente versão de formato)
- [ ] FR-07: `getById()` valida com schema Zod; retorna `null` se não encontrado; lança erro explícito de persistência se arquivo existe mas JSON ou schema é inválido (corrupção)
- [ ] FR-08: `list()` lê todos os arquivos do diretório, filtra por `RunListFilters` e lança erro se encontrar arquivo corrompido (comportamento determinístico e observável, não silencioso)
- [ ] FR-09: `findByIdempotencyKey()` varre arquivos e retorna `null` se não encontrar correspondência
- [ ] FR-10: Formato de arquivo inclui `schemaVersion` (migrações futuras) e `revision` (concorrência)
- [ ] FR-11: Pelo menos um cenário de concorrência simultânea no mesmo `runId` é coberto por teste

### FileCheckpointRepository

- [ ] CK-01: Interface `CheckpointRepository` definida com métodos `create()`, `getLatest()`, `listByRunId()`
- [ ] CK-02: `createCheckpoint()` permanece função de domínio pura em `automation/domain/checkpoint.ts` sem depender de `CheckpointRepository` nem de filesystem
- [ ] CK-03: `FileCheckpointRepository` implementa `CheckpointRepository` em `automation/adapters/file-checkpoint-repo.ts`; checkpoints persistidos como JSON por `runId`
- [ ] CK-04: Checkpoint sobrevive ao encerramento do processo; leitura valida com Zod; arquivo corrompido lança erro explícito (não retorna `null` silenciosamente)
- [ ] CK-05: `getLatest()` retorna checkpoint mais recente para um `runId`; checkpoint de `waiting_manual` inclui contexto da ação necessária

### Restart Recovery

- [ ] RR-01: `detectInterruptedRuns(repo)` retorna todos os `RunRecord` em estado `running`
- [ ] RR-02: `recoverRun()` é conservador: para cada run em `running`, consulta status/idempotência remota via `adapter.checkStatus()` quando disponível; se evidência de conclusão remota, transita `running → succeeded`; se necessidade confirmada de ação humana, transita `running → waiting_manual`; se operação não concluída e seguro tentar novamente, registra erro de interrupção retryable e transita `running → failed → queued` (respeitando `maxAttempts` e regras de retry); se estado remoto for ambíguo e repetir puder causar duplicação, não executa mutação — deixa evidência explícita e exige tratamento manual
- [ ] RR-03: Recovery preserva `waiting_manual` — não recupera automaticamente runs que aguardam ação humana; preserva `idempotencyKey` original
- [ ] RR-04: Recovery registra evento de recovery no `RunRecord.metadata`; estado corrompido retorna erro explícito (não silencioso)
- [ ] RR-05: Orquestrador expõe `recoveryLoop()` que executa `detectInterruptedRuns` + `recoverRun` para cada run interrompido; chamado antes de executar novos runs
- [ ] RR-06: Runs em estado terminal (`succeeded`, `cancelled`) não são processados pelo recovery; para runs em `failed`, se o erro for retryable e `attempt < maxAttempts`, recovery pode encaminhar para `queued`; caso contrário, manter `failed` sem nova execução

### Dry Run — Google Business Profile

- [ ] DR-01: `createLocalPost` suporta modo `dryRun`; em dry-run, nenhuma requisição HTTP mutável (POST/PUT/DELETE/PATCH) é enviada à API do Google Business Profile
- [ ] DR-02: Em dry-run, mesma validação de payload e credentials do fluxo real é executada; resultado inclui `dryRun: true` no output
- [ ] DR-03: Em dry-run, adapter nunca retorna `success: true` fingindo que post foi publicado — retorna dados simulados com `dryRun: true`
- [ ] DR-04: Testes verificam ausência de chamada mutável externa em modo dry-run; dry-run é executado antes de qualquer live execution

### Access Preflight Gate — Google Business Profile

- [ ] AP-01: Gate verifica que API do Google Business Profile está configurada no projeto GCP (API habilitada, projeto autorizado, endpoint correto)
- [ ] AP-02: Gate verifica que OAuth 2.0 está disponível via secret mechanism (client ID, client secret, refresh token em variáveis de ambiente)
- [ ] AP-03: Gate verifica que account/location IDs estão disponíveis via variáveis de ambiente; se qualquer credencial ou configuração necessária estiver ausente, retorna `BLOCKED_NEEDS_HUMAN`
- [ ] AP-04: Nenhuma credencial aparece em `AdapterContext`, `RunRecord`, checkpoint, log ou fixture de teste; configuração é declarada em variável de ambiente (não versionada)
- [ ] AP-05: Gate é executado antes de qualquer live execution e antes do adapter real ser instanciado

### Controlled Real Adapter — Google Business Profile

- [ ] RA-01: `GoogleBusinessProfileAdapter` implementa `PlatformAdapter` em `automation/adapters/google-business-profile-adapter.ts`, utilizando exclusivamente API oficial com OAuth 2.0 (não scraping, não browser automation)
- [ ] RA-02: Operação `createLocalPost` definida com payload schema e resultado esperado; adapter retorna `requiresManual: true` se encontrar CAPTCHA, MFA ou obstáculo ToS
- [ ] RA-03: Adapter suporta modo dry-run verificável (DR-01 a DR-04); opera com baixo blast radius (criação de post, não destruição de dados existentes)
- [ ] RA-04: `FakeAdapter` não satisfaz os critérios do adapter real — teste explícito documenta distinção; sem credenciais reais, adapter retorna `BLOCKED_NEEDS_HUMAN`

### Security / Secrets

- [ ] SG-01: Credenciais do adapter real carregadas somente via `process.env`; `redactError()` aplicado a todos os erros antes de persistir
- [ ] SG-02: `redactLog()` aplicado a todos os logs de execução do adapter real
- [ ] SG-03: Nenhum token, API key ou password aparece em `RunRecord.metadata`, checkpoint ou output persistido
- [ ] SG-04: Testes verificam ausência de secrets em fixtures e em dados persistidos pelo adapter real

### Best Fluency / PT Pilot

- [ ] FP-01: Pilot limitado a `brand: "best-fluency"`, `market: "PT"`, plataforma Google Business Profile, operação `createLocalPost`
- [ ] FP-02: Pilot é opt-in via `LIVE_PILOT_ENABLED=true`; CI nunca executa live execution; dry-run executado com sucesso antes de qualquer live execution
- [ ] FP-03: Live smoke test é evidência manual separada, nunca obrigatório no CI; se credenciais/autorização não disponíveis, sistema para em `BLOCKED_NEEDS_HUMAN`

### Testes

- [ ] T-01: Testes unitários para `FileRunRepository` — create, getById, update, list, findByIdempotencyKey, atomicidade
- [ ] T-02: Testes unitários para `FileCheckpointRepository` — create, getLatest, listByRunId
- [ ] T-03: Testes unitários para detecção de corrupção em `FileRunRepository` e `FileCheckpointRepository` (JSON inválido, schema mismatch → erro explícito)
- [ ] T-04: Testes unitários para `detectInterruptedRuns` e `recoverRun`
- [ ] T-05: Testes unitários para redação de secrets em erros e logs do adapter real
- [ ] T-06: Teste de integração: `FileRunRepository` + `FileCheckpointRepository` com criação, leitura e atualização de `RunRecord` e checkpoints
- [ ] T-07: Testes de recovery: interrupção simulada + restart + recuperação de run em `running` via `running → failed → queued` (com checkStatus remoto); preservação de `waiting_manual`; idempotência mantida após restart; checkpoint recovery restaura estado válido; estado corrompido retorna erro explícito; estado remoto ambíguo não executa mutação
- [ ] T-08: Teste E2E local: execução completa com `FileRunRepository` + `FileCheckpointRepository` + `FakeAdapter`; recovery após crash simulado; dry-run do adapter real com verificação de ausência de mutação
- [ ] T-09: Teste de integração: Access Preflight Gate retorna `BLOCKED_NEEDS_HUMAN` sem credenciais
- [ ] T-10: Teste unitário para dry-run do adapter real (verificação de ausência de mutação com mock/spy)
- [ ] T-11: Teste de concorrência: atualizações simultâneas no mesmo `runId` verificam `revision` e rejeitam conflito
- [ ] T-12: Teste unitário para `recoveryLoop` — verificando que processa runs em `running` (transição via `failed → queued` quando retryable), processa runs em `failed` retryável para `queued`, não processa `succeeded`/`cancelled` e não altera `waiting_manual`
- [ ] T-13: Teste de integração: `FileCheckpointRepository` mantém histórico de checkpoints (múltiplos checkpoints para mesmo `runId`, `getLatest()` retorna o mais recente)

### Documentação

- [ ] DC-01: Documentação arquitetural atualizada com seção de persistência filesystem e diagrama de fluxo de recovery
- [ ] DC-02: Guia de configuração do adapter real (OAuth 2.0, account/location IDs, variáveis de ambiente) e documentação de dry-run
- [ ] DC-03: Documentação do live smoke test (passos, pré-requisitos, rollback); atualização do roadmap.md com Sprint 3

## Fora de Escopo da Sprint 3

- Dashboard / frontend
- Scheduler / batch processing
- Analytics / reporting
- Multi-market
- Banco de dados
- Browser automation / scraping
- Múltiplos adapters reais
- Deployment automatizado na VPS
- API HTTP
- Migração de dados

## Dependências

- Sprint 1 concluída (domínio de execução, idempotência, state machine, checkpoints)
- Sprint 2 concluída (framework de adapters, FakeAdapter, orquestrador, status sync)
- Zod (já implementado)
- Vitest (já implementado)
- TypeScript (já implementado)

## Status

A aplicação permanece `NO-GO` para produção até a conclusão desta Sprint.
