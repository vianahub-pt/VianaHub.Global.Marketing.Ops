# Agent Loop - VianaHub Global Marketing Ops

## Visão Geral

O agent loop é um sistema multiagente limitado, auditável e human-in-the-loop para desenvolvimento assistido por IA.

## Arquitetura

```
┌─────────────────────────────┐
│     Sprint Orchestrator     │
│      (mode: primary)        │
│   Coordena o loop inteiro   │
└──────────┬──────────────────┘
           │
    ┌──────┼──────┬──────────┬──────────┐
    ▼      ▼      ▼          ▼          ▼
┌───────┐┌───────┐┌────────┐┌────────┐┌────────┐
│Architect││Implement││ Tester ││Security││Reviewer│
│(read) ││(write) ││ (exec) ││ (read) ││ (read) │
└───────┘└───────┘└────────┘└────────┘└────────┘
```

## Agentes

| Agente | Modo | Steps | Edição | Bash | Escopo |
|--------|------|------:|--------|------|--------|
| sprint-orchestrator | primary | 70 | loop-state.md | read-only | Coordenação |
| sprint-architect | subagent | 20 | deny | read-only | Análise |
| sprint-implementer | subagent | 40 | allowlist | read-only | Código |
| sprint-tester | subagent | 30 | deny | quality gates | Testes |
| sprint-security | subagent | 25 | deny | read-only | Segurança |
| sprint-reviewer | subagent | 25 | deny | read-only | Review |

## Limites de Steps

O campo `steps` limita cada sessão/invocação do respetivo agente. Cada agente possui seu próprio limite explícito:

- `sprint-orchestrator`: 70 steps
- `sprint-architect`: 20 steps
- `sprint-implementer`: 40 steps
- `sprint-tester`: 30 steps
- `sprint-security`: 25 steps
- `sprint-reviewer`: 25 steps

Quando o limite é atingido, o agente recebe um prompt especial para resumir seu trabalho e tarefas restantes.

## Profundidade de Subagentes

`subagent_depth: 1` impede delegação adicional. Subagentes não podem criar outros subagentes.

## Protocolo

1. Orchestrator lê spec e estado
2. Architect produz plano
3. Orchestrator seleciona incremento
4. Implementer implementa
5. Tester executa testes focados
6. Se falhar → volta ao implementer
7. Se passar → gates completos
8. Security e Reviewer fazem review independente
9. Consolidar findings
10. Se BLOCKER/HIGH/MEDIUM → nova iteração
11. Máximo 5 ciclos (limite do protocolo do orquestrador)
12. Parar com estado final

## Estados Finais

- `READY_FOR_HUMAN_REVIEW` — sucesso técnico
- `BLOCKED_NEEDS_HUMAN` — requer intervenção
- `MAX_ITERATIONS_REACHED` — limite de ciclos ou steps atingido
- `FAILED_QUALITY_GATES` — gates falharam

## Condições de Parada

- Requisito ambíguo
- Mudança de negócio
- Necessidade de credenciais
- Acesso à VPS
- Alteração destrutiva
- Nova dependência não prevista
- Mudança em dados de mercados
- Tentativa de editar GERIT
- Regressão dos quality gates
- Conflito sem solução objetiva
- Expansão de escopo
- Suspeita de secret

## Uso

```bash
/sprint-loop sprint-1
```

## Segurança

- Subagentes não podem criar outros subagentes (`subagent_depth: 1`)
- Compartilhamento desabilitado (`share: "disabled"`)
- Permissões granulares por agente
- Bloqueio explícito de operações perigosas
- Nenhum acesso a infraestrutura externa
- Cada agente possui `steps` explícito — subagentes não herdam limites do orquestrador
- Limite de 5 ciclos pertence ao protocolo do orquestrador, não aos agentes individuais
- Qualquer limite atingido resulta em `MAX_ITERATIONS_REACHED` ou `BLOCKED_NEEDS_HUMAN`

## Política de Proteção de Arquivos Sensíveis

A política global de leitura protege arquivos sensíveis:

- `.env` e `.env.*` — negado
- `*.pem`, `*.key`, `*.p12`, `*.pfx` — negado
- `id_rsa`, `id_ed25519` — negado
- `*.env.example` — permitido (útil como referência)

A política usa regra de último match: `.env.*` é negado, mas `*.env.example` é permitido.
