# VianaHub Global Marketing Ops

Solução desacoplada para operações de marketing, presença digital e cadastros em diretórios empresariais para múltiplas marcas da VianaHub, com suporte a múltiplos mercados internacionais.

> **Este NÃO é o site da Best Fluency nem da GERIT.** É um projeto independente responsável por operações de marketing e presença digital.

---

## Propósito

Gerenciar de forma centralizada e automatizável:

- Cadastros em diretórios empresariais internacionais
- Presença digital de múltiplas marcas em múltiplos mercados
- Dados de negócio padronizados
- Status e histórico de operações por mercado

---

## Arquitetura

```
Brand (dados da marca)
    ↓
Market (país/mercado alvo)
    ↓
Platform (plataforma específica do mercado)
    ↓
Adapter (integração técnica)
    ↓
External Platform (diretório/site externo)
```

A separação entre **Brand Data**, **Market**, **Platform** e **Automation Engine** permite que:

- Novas marcas sejam adicionadas apenas com dados
- Novos mercados sejam ativados sem alterar código
- Novas plataformas sejam integradas com um novo adapter
- Qualquer marca funcione com qualquer adapter em qualquer mercado

### Brand Data vs Automation Engine

| Componente | Localização | Conteúdo |
|-----------|-------------|----------|
| **Brand Data** | `brands/<marca>/` | Dados do negócio, descrições por locale |
| **Market Config** | `brands/<marca>/markets/` | Mercados alvo e status por mercado |
| **Automation Engine** | `automation/` | Código de integração, workflows, tipos |
| **Platform Catalog** | `data/platforms/` | Catálogo de plataformas por mercado |

### Locale ≠ Market

| Concepto | Definição | Exemplo |
|----------|-----------|---------|
| **Locale** | Idioma + região (BCP 47) | `en-US`, `pt-BR`, `fr-FR` |
| **Market** | País ou região geográfica | `US`, `BR`, `FR` |

O Automation Engine trabalha com **market** (país), não com locale.

---

## Estrutura de Pastas

```
VianaHub.Global.Marketing.Ops/
├── brands/                              # Dados das marcas
│   ├── best-fluency/
│   │   ├── business-profile/            # Dados do negócio
│   │   │   ├── master-data.json
│   │   │   └── descriptions/            # Textos por locale
│   │   │       ├── pt-PT.md
│   │   │       ├── pt-BR.md
│   │   │       ├── en-US.md
│   │   │       ├── es-ES.md
│   │   │       ├── fr-FR.md
│   │   │       ├── de-DE.md
│   │   │       ├── it-IT.md
│   │   │       ├── ja-JP.md
│   │   │       ├── ru-RU.md
│   │   │       └── zh-CN.md
│   │   ├── markets/                     # Mercados alvo
│   │   │   ├── targets.json             # Configuração de mercados
│   │   │   ├── PT.csv
│   │   │   ├── BR.csv
│   │   │   ├── US.csv
│   │   │   ├── ES.csv
│   │   │   ├── FR.csv
│   │   │   ├── DE.csv
│   │   │   ├── IT.csv
│   │   │   ├── JP.csv
│   │   │   ├── RU.csv
│   │   │   └── CN.csv
│   │   └── assets/
│   └── gerit/
│       └── (mesma estrutura)
│
├── automation/                          # Engine de automação
│   ├── playwright/
│   │   ├── adapters/
│   │   ├── workflows/
│   │   └── playwright.config.ts
│   └── common/
│       ├── types.ts
│       └── index.ts
│
├── data/
│   └── platforms/                       # Catálogo de plataformas
│       ├── global/platforms.json
│       ├── PT/platforms.json
│       ├── BR/platforms.json
│       ├── US/platforms.json
│       ├── ES/platforms.json
│       ├── FR/platforms.json
│       ├── DE/platforms.json
│       ├── IT/platforms.json
│       ├── JP/platforms.json
│       ├── RU/platforms.json
│       └── CN/platforms.json
│
├── reports/                             # Relatórios por marca/mercado
│   ├── best-fluency/
│   │   ├── PT/
│   │   ├── BR/
│   │   └── ...
│   └── gerit/
│       └── ...
│
├── docs/
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Segurança

- **Nunca** versionar passwords, tokens, cookies ou credenciais
- `.gitignore` protege `.env`, `storage-state.json`, `credentials/`
- Usar variáveis de ambiente para dados sensíveis
- Automação deve respeitar termos de serviço das plataformas
- Ver `docs/automation-policy.md` para política completa

---

## Como Adicionar uma Nova Marca

1. Criar pasta `brands/<nova-marca>/`
2. Criar `business-profile/master-data.json` com dados do negócio
3. Criar `business-profile/descriptions/` com textos por locale
4. Criar `markets/targets.json` definindo quais mercados ativar
5. Criar CSVs `markets/<COUNTRY>.csv` para cada mercado alvo
6. Criar `assets/` para logotipos e imagens

---

## Como Adicionar uma Nova Plataforma

1. Adicionar entrada em `data/platforms/<COUNTRY>/platforms.json` (ou `global/`)
2. Criar adapter em `automation/playwright/adapters/<plataforma>.ts` (futuro)
3. Adicionar marca alvo nos CSVs de mercado da marca

---

## Como Ativar um Novo Mercado para uma Marca

1. Adicionar entrada em `brands/<marca>/markets/targets.json`
2. Criar CSV `brands/<marca>/markets/<COUNTRY>.csv`
3. Popular CSV com plataformas alvo

---

## Mercados Suportados

| País | Locale | Código |
|------|--------|--------|
| Portugal | pt-PT | PT |
| Brasil | pt-BR | BR |
| Estados Unidos | en-US | US |
| Espanha | es-ES | ES |
| França | fr-FR | FR |
| Alemanha | de-DE | DE |
| Itália | it-IT | IT |
| Japão | ja-JP | JP |
| Rússia | ru-RU | RU |
| China | zh-CN | CN |

---

## Current Operational Focus

**Brand:** Best Fluency
**Market:** Portugal (PT)

---

## Status Atual

**Versão:** 0.3.0 (Portugal Platform Catalog)

- [x] Estrutura de pastas criada
- [x] Brands: Best Fluency e GERIT com dados iniciais
- [x] Suporte a 10 mercados internacionais
- [x] Catálogo de plataformas (estrutura + exemplos)
- [x] Interface de adapter definida (brand + market + platform)
- [x] Configuração Playwright
- [x] Documentação de arquitetura e política
- [x] TypeScript configurado
- [x] Marketing Ops Core implementado
- [x] Brand/Market/Platform loaders
- [x] Status manager e report generator
- [x] CLI funcional
- [x] Testes unitários
- [x] Catálogo real Portugal: 9 plataformas (4 globais + 5 PT)
- [ ] Dados empresariais completos (Best Fluency)
- [ ] Adapters implementados
- [ ] Workflows de automação

---

## Setup

```bash
npm install
```

---

## Comandos

```bash
# Verificar tipos
npm run typecheck

# Executar testes unitários
npm run test

# Marketing Ops CLI
npm run ops -- validate --brand best-fluency --market PT
npm run ops -- status --brand best-fluency --market PT
npm run ops -- report --brand best-fluency --market PT
```

---

## Docs

- [Arquitetura](docs/architecture.md)
- [Onboarding de Plataformas](docs/onboarding-platform.md)
- [Política de Automação](docs/automation-policy.md)
