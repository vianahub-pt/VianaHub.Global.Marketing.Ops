# Onboarding de Plataformas

Guia para adicionar uma nova plataforma ao catálogo Marketing Ops.

---

## Passo 1: Criar entrada no catálogo de plataformas

Dependendo do âmbito da plataforma:

### Plataforma global (válida em múltiplos países)

Editar `data/platforms/global/platforms.json` e adicionar:

```json
{
  "id": "minha-plataforma",
  "name": "Minha Plataforma",
  "country": "GLOBAL",
  "locale": null,
  "url": "https://minhaplataforma.com",
  "registrationType": "form",
  "automationMode": "semi-automatic",
  "requiresLogin": true,
  "requiresCaptcha": false,
  "requiresEmailVerification": true,
  "requiresPhoneVerification": false,
  "enabled": true,
  "notes": "Descrição breve da plataforma"
}
```

### Plataforma específica de um país

Editar `data/platforms/<COUNTRY>/platforms.json` e adicionar:

```json
{
  "id": "minha-plataforma-pt",
  "name": "Minha Plataforma Portugal",
  "country": "PT",
  "locale": "pt-PT",
  "url": "https://minhaplataforma.pt",
  "registrationType": "form",
  "automationMode": "semi-automatic",
  "requiresLogin": true,
  "requiresCaptcha": false,
  "requiresEmailVerification": true,
  "requiresPhoneVerification": false,
  "enabled": true,
  "notes": "Descrição breve da plataforma"
}
```

---

## Passo 2: Criar adapter (futuro)

Em `automation/playwright/adapters/<plataforma>.ts`:

1. Implementar a interface `PlatformAdapter` de `automation/common/types.ts`
2. O adapter deve:
   - Aceitar dados de qualquer marca via `configure({ brand, market, platform })`
   - Interagir com a plataforma externa
   - Retornar `RegistrationResult` com status e URL do listing

---

## Passo 3: Adicionar às marcas

Para cada marca que deseja usar esta plataforma:

1. Verificar se o mercado está habilitado em `brands/<marca>/markets/targets.json`
2. Adicionar linha ao CSV `brands/<marca>/markets/<COUNTRY>.csv`
3. Definir `enabled=true` e `priority` conforme necessidade

---

## Passo 4: Testar

1. Executar adapter com dados de teste
2. Verificar se o listing foi criado/atualizado
3. Atualizar CSV do mercado da marca com o resultado

---

## Modos de Automação

| Modo | Descrição |
|------|-----------|
| `automatic` | Cadastro completo sem intervenção humana |
| `semi-automatic` | Requer confirmação humana em pontos-chave (login, captcha, verificação) |
| `manual` | Apenas auxílio na preparação; cadastro é feito manualmente |

**Recomendação:** Começar sempre com `semi-automatic` quando houver login, captcha ou verificação.
