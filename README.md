# MANDATO — Plataforma de Criação, Gestão e Governação de Agentes de IA

Plataforma SaaS B2B multi-empresa em **Português Europeu (pt-PT)** para criação visual de agentes de IA, orquestração de fluxos de trabalho, motor de políticas *default-to-deny*, aprovações humanas obrigatórias e auditoria imutável.

## Funcionalidades Principais

- **Fábrica de Agentes**: Assistente visual de 7 passos com geração assistida de instruções (Google Gemini), 10 modelos pré-configurados, Sandbox de testes (*Simulação* vs *Operação Governada*) e registo de agentes externos.
- **Governação e Segurança**: Motor de autorização determinístico no servidor (`ALLOWED`, `REQUIRES_APPROVAL`, `BLOCKED`), bloqueios absolutos não ultrapassáveis, deteção de *prompt injection*, isolamento multi-empresa e fila de aprovações humanas com justificação obrigatória.
- **Base de Dados no Google Drive da Empresa**: Ligação com a conta Google/Gmail empresarial (em **12. Definições**) para criar, sincronizar, listar, restaurar e gerir ficheiros de base de dados da empresa na pasta `MANDATO - Base de Dados` do Google Drive.
- **Gateway REST (`/api/v1/authorize`)**: Endpoint autenticado por credencial de agente (guardada apenas em *hash* SHA-256), com *rate limiting* e proteção de idempotência.

## Arranque Local

```bash
npm install
npm run dev
```

A aplicação fica disponível em `http://localhost:3000`.

## Testes

```bash
npm test
```

## Build e Produção (Node.js v22+)

```bash
npm run build
NODE_ENV=production npm start
```

## Variáveis de Ambiente

Consulte `.env.example` para configurar as variáveis no servidor (nunca expostas no browser):

- `GEMINI_API_KEY`: Chave da API Google Gemini (necessária para inferência real e geração de instruções).
- `MANDATO_SESSION_SECRET`: Segredo para assinatura de tokens de sessão em produção.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`: Opcionais, caso pretenda ligar a um projeto Supabase PostgreSQL + Auth (ver `supabase/migrations/001_initial_schema.sql` e `supabase/seed.sql`).
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`: Opcionais para provedores adicionais.

## Publicar no GitHub e Deploy

1. O ficheiro `.gitignore` já exclui `node_modules/`, `dist/`, `.env*` (exceto `.env.example`), `.data/` (base SQLite local de execução) e artefactos de teste.
2. Utilize a opção **Save to GitHub / Export** do ambiente para publicar o repositório na sua conta GitHub.
3. Para deploy em produção (Cloud Run ou servidor Node.js 22), utilize `npm run build` como passo de compilação e `npm start` (`node server.ts`) como comando de arranque.
