# Marketing Ops - Arquitetura

## Visão Geral

O **VianaHub.Global.Marketing.Ops** é uma solução desacoplada para gerenciar operações de marketing, presença digital e cadastros em diretórios empresariais para múltiplas marcas da VianaHub, com suporte a múltiplos mercados internacionais.

> **Importante:** Este projeto NÃO é o site da Best Fluency nem da GERIT. É um projeto independente responsável por operações de marketing e presença digital.

---

## Fluxo Conceitual

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

### Exemplo 1: Best Fluency no Cylex Portugal

```
Best Fluency
    ↓
Portugal (PT)
    ↓
Cylex PT
    ↓
Cylex Adapter
    ↓
cylex.pt
```

### Exemplo 2: Best Fluency numa plataforma espanhola

```
Best Fluency
    ↓
Spain (ES)
    ↓
Plataforma ES
    ↓
Adapter correspondente
    ↓
site da plataforma em Espanha
```

### Exemplo 3: GERIT no mesmo Cylex Portugal

```
GERIT
    ↓
Portugal (PT)
    ↓
Cylex PT (reutilizado)
    ↓
Cylex Adapter (reutilizado)
    ↓
cylex.pt
```

O mesmo adapter serve qualquer marca. Os dados vêm de `brands/<brand>/business-profile/`.

---

## Locale ≠ Market

**Importante:** locale e market são conceitos distintos.

| Concepto | Definição | Exemplo |
|----------|-----------|---------|
| **Locale** | Combinação de idioma + região (BCP 47) | `en-US`, `pt-BR`, `fr-FR` |
| **Market** | País ou região geográfica alvo | `US`, `BR`, `FR` |

No futuro podemos ter:

- `en-GB` → market `GB`
- `en-CA` → market `CA`
- `fr-CA` → market `CA`

sem alterar o Automation Engine.

Da mesma forma, o idioma português serve dois mercados:

- `pt-PT` → market `PT`
- `pt-BR` → market `BR`

O Automation Engine trabalha com **market** (país), não com locale.

---

## Separação de Responsabilidades

### Brand Data (`brands/`)

Cada marca contém apenas:
- **master-data.json**: dados empresariais (nome, morada, redes sociais, etc.)
- **descriptions/**: textos descritivos por locale (pt-PT, en-US, es-ES, etc.)
- **markets/**: quais mercados a marca ativa, com CSVs de estado por mercado
- **assets/**: logotipos, imagens e outros recursos visuais

**Nenhuma marca contém lógica de automação.**

### Market Data

Cada mercado é representado por um código de país (PT, BR, US, ES, FR, DE, IT, JP, RU, CN).

O arquivo `markets/targets.json` define quais mercados a marca ativa e a prioridade de cada um.

Os CSVs em `markets/<COUNTRY>.csv` rastreiam o estado dos cadastros naquela mercado.

### Automation Engine (`automation/`)

- **playwright/adapters/**: implementações específicas por plataforma (cylex.ts, hotfrog.ts, etc.)
- **playwright/workflows/**: fluxos de trabalho que orquestram adapters
- **common/**: tipos compartilhados, interfaces, utilitários

Um adapter é genérico — recebe dados de qualquer marca + mercado e interage com uma plataforma específica.

### Platform Data (`data/platforms/`)

Catálogo de plataformas organizado por mercado:

```
data/platforms/
  global/platforms.json    # Plataformas globais (country = "GLOBAL")
  PT/platforms.json        # Plataformas de Portugal
  BR/platforms.json        # Plataformas do Brasil
  US/platforms.json        # Plataformas dos EUA
  ...
```

Cada plataforma é definida UMA vez com:
- capacidades (login, captcha, verificação)
- modo de automação suportado
- mercado de atuação

---

## Princípios de Design

1. **Desacoplamento**: marcas não sabem nada sobre plataformas; plataformas não sabem nada sobre marcas
2. **Extensibilidade**: novas marcas e plataformas são adicionadas apenas com dados, sem alterar código
3. **Internacionalização**: o modelo suporta múltiplos mercados sem duplicar automação
4. **Segurança**: credenciais nunca são versionadas; automação respeita termos de serviço
5. **Transparência**: status de cada cadastro é rastreado em CSVs por mercado

---

## Fluxo de Dados

```
1. Definir dados da marca       → brands/<brand>/business-profile/master-data.json
2. Definir mercados alvo        → brands/<brand>/markets/targets.json
3. Configurar plataforma        → data/platforms/<COUNTRY>/platforms.json
4. Implementar adapter          → automation/playwright/adapters/<platform>.ts
5. Executar workflow            → automation/playwright/workflows/
6. Atualizar status             → brands/<brand>/markets/<COUNTRY>.csv
```

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
