# Loop State - Sprint 1

## Informações Gerais

- **Branch:** feature/sprint-1-execution-domain
- **SHA-base:** 5afabdf6ef61c0b241c67dec3d81a248f9c5fca3
- **Objetivo:** Implementar o domínio de execução e idempotência definido em docs/sprints/sprint-1/spec.md.
- **Iteração atual:** 2
- **Máximo de iterações:** 5

O orquestrador preencherá `Branch` e `SHA-base` após o preflight da execução futura.

## Estado do Loop

- **Status:** `BLOCKED_NEEDS_HUMAN`
- **Incremento atual:** Correção de identidade/idempotência do ciclo 1; sem início do ciclo 2
- **Arquivos alterados:** `automation/domain/idempotency.ts`, `automation/domain/idempotency.test.ts`, `automation/domain/index.ts`, este arquivo
- **Testes executados:** 169/169 em `npm run test:coverage`; cobertura global 93,65%; `lint`, `typecheck`, `validate:data`, `build` e `git diff --check` aprovados; `format:check` continua falhando nos dois arquivos de domínio; `npm audit --audit-level=high` bloqueado pelo ambiente; filtros literais focados não encontraram arquivos

## Escopo de Edição do Implementador

- `automation/domain/**` — lógica de domínio
- `automation/application/**` — lógica de aplicação
- `docs/architecture/**` — documentação arquitetural
- `docs/roadmap.md` — roadmap do projeto

## Findings Abertos

- **HIGH:** detecção incompleta de secrets arbitrários por valor permanece aberta; valores opacos em campos genéricos podem ser hashados.
- **MEDIUM:** cobertura negativa não demonstra rejeição de secrets opacos arbitrários.
- **BLOCKING:** `format:check` continua falhando em `automation/domain/idempotency.test.ts` e `automation/domain/idempotency.ts`.
- **RESOLVIDOS:** colisões por objetos não-JSON e identidade inválida foram rejeitadas pelos reviewers após correção.

## Decisões Tomadas

O ciclo 1 não é aprovado. A proteção contra secrets arbitrários exige decisão sobre um contrato/allowlist de payload seguro, requisito ambíguo não definido na especificação; também é necessário desbloquear a formatação.

## Bloqueios

`npm audit --audit-level=high` não pôde ser executado por bloqueio de permissão do ambiente. A execução do Prettier foi bloqueada e o `format:check` permanece falho.

## Plano verificável e matriz de cobertura

Plano aprovado do `sprint-architect`: cinco ciclos, iniciando por identidade e idempotência.

| Ciclo | Critérios de aceitação cobertos |
|---|---|
| 1 | I-01 `RunId` UUID v4 aleatório; I-02 `createRunId()` não determinístico; I-03 unicidade por execução; I-04 `IdempotencyKey` string; I-05 `computeIdempotencyKey()` pura/determinística; I-06 derivação por identidade e payload canônico; I-07 `PayloadFingerprint` SHA-256 hexadecimal; I-08 serialização canônica; I-09 rejeição de dados sensíveis antes do hash; I-10 múltiplas execuções; I-11 reutilização somente para solicitação idêntica |
| 2 | R-01 `RunRecord`; R-02 `schemaVersion`; R-03 `runId`; R-04 `brandId`; R-05 `market`; R-06 `platform`; R-07 `operation`; R-08 `state`; R-09 `attempt`; R-10 `maxAttempts`; R-11 `idempotencyKey`; R-12 `payloadFingerprint`; R-13 `createdAt`; R-14 `updatedAt`; R-15 `startedAt`; R-16 `finishedAt`; R-17 `error`; R-18 `metadata`; R-19 validação Zod; R-20 nomenclatura canônica; S-01 estados; S-02 estado inicial `queued` |
| 3 | M-01 validação de transições; M-02 inválidas lançam erro; M-03 `queued -> running`; M-04 `queued -> cancelled`; M-05 `running -> waiting_manual`; M-06 `running -> succeeded`; M-07 `running -> failed`; M-08 `running -> cancelled`; M-09 `waiting_manual -> running`; M-10 `waiting_manual -> failed`; M-11 `waiting_manual -> cancelled`; M-12 retry de `failed`; M-13 terminalidade de `succeeded`; M-14 terminalidade de `cancelled`; M-15 terminalidade condicional de `failed`; M-16 intervenção humana; M-17 não usar `waiting_manual` por exaustão; T-01 tentativa inicial; T-02 incremento; T-03 limite; T-04 padrão 3; T-05 configuração; T-06 retryable; T-07 tentativas disponíveis |
| 4 | E-01 `redactError()`; E-02 `redactLog()`; E-03 padrões JWT/API key/password/session ID; P-01 `RunRepository`; P-02 `create()`; P-03 `getById()`; P-04 `update()`; P-05 `list()`; P-06 `findByIdempotencyKey()`; P-07 independência tecnológica; P-08 concorrência otimista documentada; C-01 contrato/decisão de checkpoint; C-02 estado serializável |
| 5 | TST-01 testes unitários; TST-02 integração do fluxo completo; TST-03 recuperação após falha; TST-04 cobertura mínima de 80%; D-01 documentação arquitetural; D-02 diagrama de estados; D-03 guia de `RunRepository` |

Incremento selecionado para o ciclo 1: primitivas de identidade/idempotência e seus testes unitários, sem `RunRecord`, máquina de estados, repository, adapter ou store.

## Próximo Passo

Solicitar decisão humana sobre o contrato de payload seguro/allowlist e desbloqueio da execução de formatação; depois retomar a correção do ciclo 1.

## Evidências de cobertura

- Concluídos/evidenciados no ciclo 1: I-01, I-02, I-03, I-04, I-05, I-06, I-07, I-08, I-10 e I-11.
- Pendente: I-09, devido à impossibilidade de garantir rejeição de secrets arbitrários em campos genéricos.
- Todos os critérios R-01 a D-03 permanecem pendentes, conforme distribuição planejada nos ciclos 2 a 5.

## Estado Final

`BLOCKED_NEEDS_HUMAN`: finding HIGH de segurança sobre secrets arbitrários, requisito ambíguo de allowlist/contrato seguro, `format:check` falho e `npm audit` não executável no ambiente.

## Estado Final

Aguardando início do loop.
