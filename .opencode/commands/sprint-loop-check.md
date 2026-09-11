---
description: Verifica o roteamento dos agentes personalizados da Sprint 1 sem modificar o repositório
agent: sprint-orchestrator
subtask: false
---

# Verificação de Roteamento do Loop da Sprint

Este comando é estritamente somente leitura. Ele não deve editar arquivos, executar comandos de shell ou testes, atualizar `loop-state`, acessar arquivos sensíveis, realizar operações Git ou ler especificações da Sprint. Não use `ARGUMENTS` nem parâmetros posicionais. Esta verificação nunca deve invocar `/sprint-loop` nem iniciar a Sprint 1.

O `sprint-orchestrator` pode usar somente o mecanismo de delegação necessário para invocar os cinco subagentes personalizados relacionados abaixo. Cada subagente deve usar zero ferramentas, não ler arquivos, não executar comandos, não modificar estado e retornar somente seu token `AGENT_OK` exato.

## Política obrigatória de idioma no OpenCode Desktop

Toda comunicação de autoria do orquestrador dirigida ao usuário e visível durante esta verificação deve ser escrita diretamente em português do Brasil (`pt-BR`), independentemente do idioma do prompt. Isso inclui mensagens de progresso, explicações, títulos de delegação, resumos e resultado final. O raciocínio ou pensamento visível gerado pelo modelo pode permanecer no idioma nativo do modelo.

Não traduza nomes de agentes, nomes de ferramentas, comandos, caminhos ou tokens de protocolo.

## Verificação de identidade

O contexto de agente ativo fornecido pelo frontmatter `agent: sprint-orchestrator` é a única evidência de identidade permitida. Nunca leia `AGENTS.md`, `loop-state.md`, especificações da Sprint, arquivos do repositório, arquivos de configuração ou informações do ambiente para confirmar a identidade.

Se o agente ativo do sistema não for claramente `sprint-orchestrator`, retorne somente `INVALID_ORCHESTRATOR_CONTEXT`, sem usar ferramentas, e pare.

## Limite de ferramentas

Durante toda a verificação, o orquestrador deve fazer exatamente cinco chamadas de ferramenta no total. Todas devem usar exclusivamente o mecanismo de delegação, uma vez para cada agente personalizado, na ordem exata apresentada abaixo.

A primeira chamada deve delegar para `sprint-architect`.

São proibidos `read`, `glob`, `list`, `grep`, `bash`, `edit`, `write`, `web`, `question`, `todo`, `skill`, Git, shell, testes e qualquer outra ferramenta ou operação além das cinco delegações permitidas.

## Verificação do roteamento

Usando exclusivamente o mecanismo de delegação, delegue exatamente uma vez para cada agente na seguinte ordem:

1. `sprint-architect`
2. `sprint-implementer`
3. `sprint-tester`
4. `sprint-security`
5. `sprint-reviewer`

Use exatamente as seguintes mensagens de delegação, na mesma ordem:

1. `ROUTING_PROBE_ONLY: retorne somente AGENT_OK:sprint-architect; não use ferramentas nem realize qualquer outra operação.`
2. `ROUTING_PROBE_ONLY: retorne somente AGENT_OK:sprint-implementer; não use ferramentas nem realize qualquer outra operação.`
3. `ROUTING_PROBE_ONLY: retorne somente AGENT_OK:sprint-tester; não use ferramentas nem realize qualquer outra operação.`
4. `ROUTING_PROBE_ONLY: retorne somente AGENT_OK:sprint-security; não use ferramentas nem realize qualquer outra operação.`
5. `ROUTING_PROBE_ONLY: retorne somente AGENT_OK:sprint-reviewer; não use ferramentas nem realize qualquer outra operação.`

Cada subagente deve usar zero ferramentas e retornar somente seu token exato:

- `AGENT_OK:sprint-architect`
- `AGENT_OK:sprint-implementer`
- `AGENT_OK:sprint-tester`
- `AGENT_OK:sprint-security`
- `AGENT_OK:sprint-reviewer`

Nunca use `build`, `general`, `explore`, `scout`, agentes de fallback ou qualquer outro agente. Qualquer cartão de delegação da interface chamado `General` invalida a verificação.

## Resultado

Retorne somente `AGENT_ROUTING_PASS` quando a transcrição contiver exatamente as cinco delegações autorizadas para os agentes personalizados, seus cinco tokens exatos e nenhuma outra chamada de ferramenta.

Ao primeiro erro, não faça as delegações restantes e retorne somente `INVALID_AGENT_ROUTING`. Isso se aplica se ocorrer qualquer chamada adicional de ferramenta, acesso a arquivo, operação que não seja delegação, agente indisponível, substituído ou ausente, token diferente do esperado, agente de fallback ou cartão da interface chamado `General`.

Não produza relatório, tabela, explicação ou qualquer texto adicional junto ao token final.
