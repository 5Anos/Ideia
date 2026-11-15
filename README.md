# MANDATO — Plataforma de Criação, Gestão e Governação de Agentes de IA

> **"Os agentes de IA podem trabalhar autonomamente dentro de limites claramente definidos, mas as ações sensíveis permanecem sob controlo humano."**

O **MANDATO** é uma plataforma SaaS empresarial B2B multi-empresa (*multi-tenant*) de **Fábrica e Governação de Agentes de IA**, concebida em Português Europeu (`pt-PT`, EUR `€`, `DD/MM/YYYY`, `24h`).

---

## 1. Arquitetura Multi-Tenant com Google Sheets por Empresa

Cada empresa registada no **MANDATO** opera em **isolamento estrito**:

- **Plano de Controlo da Plataforma (`.mandato-control-plane/`)**:
  - `registry.json`: contém exclusivamente utilizadores da plataforma, associações RBAC (`OWNER`, `ADMIN`, `APPROVER`, `OPERATOR`, `VIEWER`), rotas de hash de credenciais de agentes e **metadados de ligação** por empresa (`entered_google_email`, `verified_google_email`, `spreadsheet_id`, `connection_status`, `schema_valid`, `secret_reference`).
  - `secrets.vault.json`: cofre cifrado com **AES-256-GCM** (chave derivada de `MANDATO_MASTER_ENCRYPTION_KEY` / `MANDATO_SESSION_SECRET`) onde são guardados `access_token` e `refresh_token` OAuth de cada empresa. **Nenhum token ou segredo é armazenado em texto simples nem exposto ao frontend.**
- **Base de Dados Operacional por Empresa (Google Sheets)**:
  - Cada empresa autentica a **sua própria conta Google** e seleciona ou cria a sua própria folha Google Sheets (`MANDATO — [Nome da Empresa]`) com **20 abas estruturadas** (`CompanySettings`, `Users`, `CompanyMembers`, `Agents`, `AgentVersions`, `AgentCredentials`, `AgentTools`, `Policies`, `PolicyAssignments`, `AuthorizationRequests`, `ApprovalRequests`, `ApprovalDecisions`, `Workflows`, `WorkflowNodes`, `WorkflowEdges`, `WorkflowExecutions`, `Integrations`, `Notifications`, `AuditLogs`, `IdempotencyRecords`).
  - **Zero Fallback Silencioso**: se a folha da empresa não estiver ligada ou validada, as rotas operacionais respondem explicitamente com `HTTP 503 DATABASE_NOT_CONNECTED` até a ligação ser concluída em `Definições -> Base de Dados da Empresa (Google Sheets)`.
  - **Administração da Plataforma (`13. Plataforma`)**: acessível apenas a utilizadores definidos em `MANDATO_PLATFORM_ADMINS` (ex.: `direcao@demonstracao.pt`), apresentando apenas metadados de estado das ligações sem leitura nem exposição dos dados operacionais das folhas das empresas.

---

## 2. Configuração no Google Cloud Console

Para utilizar o fluxo OAuth completo (*Authorization Code + PKCE*) em produção:

1. Aceda à [Google Cloud Console](https://console.cloud.google.com/) e selecione ou crie o projeto.
2. Em **APIs & Services -> Library**, ative:
   - **Google Sheets API** (`sheets.googleapis.com`)
   - **Google Drive API** (`drive.googleapis.com`)
3. Em **APIs & Services -> OAuth consent screen**:
   - Configure a aplicação e adicione os âmbitos (*scopes*):
     - `https://www.googleapis.com/auth/spreadsheets`
     - `https://www.googleapis.com/auth/drive.file`
     - `https://www.googleapis.com/auth/drive.metadata.readonly`
     - `openid`, `email`, `profile`
4. Em **APIs & Services -> Credentials -> Create Credentials -> OAuth client ID** (*Web application*):
   - Adicione o URI de redirecionamento autorizado:
     - Desenvolvimento local: `http://localhost:3000/api/company/sheets/oauth/callback`
     - Produção / Cloud Run: `https://<O-SEU-DOMINIO>/api/company/sheets/oauth/callback`
5. Copie o **Client ID** e o **Client Secret** para as variáveis de ambiente do servidor.

*(Em alternativa no ambiente Google AI Studio, caso `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` não estejam definidos no ambiente, o sistema ativa automaticamente a ponte segura via popup Workspace Sign-In e guarda o token cifrado exclusivamente no backend).*

---

## 3. Variáveis de Ambiente

Consulte `.env.example` para o modelo completo:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `PORT` | Não (`3000`) | Porto HTTP do servidor Express |
| `GEMINI_API_KEY` | Para IA | Chave do Google Gemini para o assistente de criação/teste de agentes |
| `MANDATO_SESSION_SECRET` | Sim em Prod | Segredo HMAC-SHA256 para assinar tokens de sessão |
| `MANDATO_MASTER_ENCRYPTION_KEY` | Sim em Prod | Chave mestra (mín. 32 chars) para cifrar o cofre `secrets.vault.json` (AES-256-GCM) |
| `MANDATO_PLATFORM_ADMINS` | Não | Emails autorizados na vista `13. Plataforma` (omissão: `direcao@demonstracao.pt`) |
| `MANDATO_CONTROL_PLANE_DIR` | Não | Diretório do plano de controlo (omissão: `.mandato-control-plane`) |
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth PKCE | Client ID OAuth 2.0 da Google Cloud Console |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth PKCE | Client Secret OAuth 2.0 (apenas servidor) |
| `GOOGLE_OAUTH_REDIRECT_URI` | OAuth PKCE | URL completo para `/api/company/sheets/oauth/callback` |

---

## 4. Instalação, Desenvolvimento e Testes

```bash
# 1. Instalar dependências
npm install

# 2. Executar em desenvolvimento (Express + Vite middlewares na porta 3000)
npm run dev

# 3. Executar todos os testes unitários e de integração (com MockGoogleApiTransport)
npm test

# 4. Compilar frontend + validar TypeScript + arrancar em produção (Node.js v22+)
npm run build
NODE_ENV=production node server.ts
```

---

## 5. Deploy no GitHub / Cloud Run

- O ficheiro `server.ts` e todos os módulos em `src/server/` utilizam imports ESM explícitos com extensão `.ts`, compatíveis diretamente com **Node.js v22+** (`node server.ts`) no Cloud Run sem etapa adicional de transpilação de servidor.
- Configure um volume persistente ou Secret Manager externo em produção para preservar `.mandato-control-plane/` entre reinícios de contentores, bem como todas as variáveis da Secção 3.
- Limites conhecidos da API Google Sheets: ~60 pedidos de escrita por minuto por utilizador/projeto; o `googleSheetsProvider.ts` inclui leitura em lote (`values:batchGet`), cache TTL por empresa (10s), *write lock* serializado por empresa e *retry* exponencial automático para respostas `429`.
