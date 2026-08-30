# Política de Automação

## Princípios Fundamentais

A automação neste projeto deve sempre respeitar:

1. **Termos de Serviço** das plataformas utilizadas
2. **Privacidade** dos dados pessoais (RGPD / LGPD / CCPA / etc.)
3. **Integridade** das operações — nunca realizar ações irreversíveis sem controle

---

## O que NÃO é permitido

A automação **NÃO deve**:

- Tentar contornar CAPTCHAs
- Contornar MFA (Multi-Factor Authentication)
- Contornar verificações de email ou telefone
- Ignorar ou violar termos de serviço de plataformas
- Armazenar passwords, tokens ou credenciais no Git
- Realizar submissões irreversíveis sem revisão humana
- Fazer scraping agressivo que sobrecarregue servidores
- Criar múltiplas contas na mesma plataforma para a mesma marca

---

## Fluxos de Automação

### Automático (`automatic`)
- Cadastro é feito completamente pela engine
- **Usar apenas** quando a plataforma não requer login, captcha ou verificação
- Exemplo: APIs públicas com autenticação via API key

### Semi-automático (`semi-automatic`)
- Engine prepara e executa o fluxo até um ponto que requer intervenção humana
- Humano confirma login, resolve captcha, ou verifica email
- **Usar como padrão** quando houver login ou verificação
- Recomendado para a maioria dos diretórios empresariais

### Manual (`manual`)
- Engine apenas prepara dados e instruções
- Cadastro é feito inteiramente por um humano
- **Usar** quando a plataforma é muito restritiva ou não suporta automação

---

## Armazenamento de Credenciais

- Nunca versionar passwords, tokens ou cookies
- Usar variáveis de ambiente (`.env`) para dados sensíveis
- O `.gitignore` deve proteger arquivos `.env`, `storage-state.json` e `credentials/`
- Em caso de dúvida, NÃO commitar

---

## Auditoria

Todas as ações de automação devem ser rastreadas:

- CSVs de `brands/<marca>/markets/<COUNTRY>.csv` regista tentativas e resultados
- `listing_url` permite verificar o estado do cadastro
- `last_checked` dão visibilidade temporal

---

## Responsabilidade

Quem executa automação é responsável por:

1. Verificar se a plataforma permite cadastro automatizado
2. Garantir que os dados são precisos e atualizados
3. Monitorar o resultado dos cadastros
4. Responder a notificações das plataformas (verificação, remoção, etc.)
