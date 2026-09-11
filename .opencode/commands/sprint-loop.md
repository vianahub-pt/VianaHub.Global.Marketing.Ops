---
description: Inicia o loop multiagente para a Sprint 1
agent: sprint-orchestrator
subtask: false
---

## Política obrigatória de idioma no OpenCode Desktop

- Toda comunicação de autoria do agente dirigida ao usuário e visível no OpenCode Desktop deve ser escrita em português do Brasil (`pt-BR`).
- Esta regra aplica-se independentemente do idioma utilizado pelo usuário no prompt.
- Isso inclui mensagens introdutórias, atualizações de progresso, explicações sobre ferramentas, títulos e textos de delegação, avisos, perguntas, resumos, relatórios e respostas finais.
- Produza diretamente em `pt-BR` todas as mensagens e respostas dirigidas ao usuário. O raciocínio ou pensamento visível gerado pelo modelo pode permanecer no idioma nativo do modelo.
- Antes de delegar, instrua cada subagente a manter em `pt-BR` toda comunicação visível dirigida ao usuário.
- Não traduza código, comandos, caminhos, nomes de arquivos, nomes de agentes, nomes de ferramentas ou identificadores técnicos.
- Preserve exatamente os tokens de protocolo, incluindo `INVALID_ORCHESTRATOR_CONTEXT`, `AGENT_ROUTING_REQUIRED`, `INVALID_AGENT_ROUTING`, `AGENT_ROUTING_PASS` e `AGENT_OK:<agente>`.
- Rótulos nativos da interface que não sejam produzidos pelos agentes ficam fora do controle desta política.

# Sprint Loop

Iniciar o loop multiagente para a Sprint 1.

Este comando é dedicado exclusivamente à Sprint 1. Não aceita argumentos.

Executar como:

```text
/sprint-loop
```

## Precondição fail-closed — identidade do orquestrador

Antes de ler qualquer especificação, editar arquivos, executar testes ou delegar, o orquestrador **deve** confirmar que a identidade primária ativa é `sprint-orchestrator`.

Se a identidade ativa não for `sprint-orchestrator` ou não puder ser confirmada, o orquestrador **deve** retornar **apenas** `INVALID_ORCHESTRATOR_CONTEXT` e parar imediatamente.

## Pré-condição fail-closed — roteamento de agentes

Antes de ler especificações da Sprint, editar arquivos, executar testes ou delegar trabalho de Sprint, a sessão atual **deve** conter um `AGENT_ROUTING_PASS` bem-sucedido produzido por `/sprint-loop-check` imediatamente antes de `/sprint-loop`.

Se essa evidência estiver ausente, obsoleta, falhar, vier de outra sessão ou contiver qualquer agente `general` ou delegação não-customizada, o orquestrador **deve** retornar **apenas** `AGENT_ROUTING_REQUIRED` e parar imediatamente sem usar ferramentas ou fazer alterações.

## Delegação exata — sem fallback

Delegar **apenas** para os subagentes:

- `sprint-architect`
- `sprint-implementer`
- `sprint-tester`
- `sprint-security`
- `sprint-reviewer`

**Nunca** usar `build`, `general`, `explore`, `scout` ou qualquer outro agente.

Se um subagente exigido não estiver disponível, interromper com `INVALID_AGENT_ROUTING`.

## Arquivos

- Especificação: `docs/sprints/sprint-1/spec.md`
- Estado do loop: `docs/sprints/sprint-1/loop-state.md`

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
