---
description: Inicia o loop multiagente para uma Sprint específica
agent: sprint-orchestrator
---

# Sprint Loop

Iniciar o loop multiagente para a Sprint: $ARGUMENTS

## Validação

1. Verificar que `docs/sprints/$ARGUMENTS/spec.md` existe
2. Ler a especificação
3. Carregar estado atual de `docs/sprints/$ARGUMENTS/loop-state.md` (se existir)
4. Iniciar protocolo do orquestrador

## Protocolo

O orquestrador deve:

1. Ler `AGENTS.md`, a especificação e o estado do loop
2. Pedir ao arquiteto um plano verificável
3. Selecionar somente um incremento pequeno
4. Pedir ao implementador a implementação
5. Pedir ao tester os testes focados
6. Se falharem, devolver ao implementador
7. Quando os testes focados passarem, executar gates completos
8. Pedir reviews independentes de segurança e código
9. Consolidar findings sem permitir que o implementador os descarte
10. Se existirem findings BLOCKER, HIGH ou MEDIUM, iniciar nova iteração
11. Repetir no máximo cinco ciclos
12. Parar com um dos estados:
    - READY_FOR_HUMAN_REVIEW
    - BLOCKED_NEEDS_HUMAN
    - MAX_ITERATIONS_REACHED
    - FAILED_QUALITY_GATES

## Restrições

- Nunca usar auto-merge
- Nunca criar commit
- Nunca fazer push
- Nunca acessar infraestrutura externa
- Interromper em condições de parada humana
